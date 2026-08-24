import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as ort from "onnxruntime-web";
import { analyzePcmQuality } from "./audio-quality.mjs";

const MODEL_ID = "Xenova/wavlm-base-plus-sv";
const MODEL_URL = "https://huggingface.co/Xenova/wavlm-base-plus-sv/resolve/main/onnx/model_quantized.onnx";
const SAMPLE_RATE = 16_000;
const WINDOW_SAMPLES = SAMPLE_RATE * 3;
const HOP_SAMPLES = SAMPLE_RATE;
const MAX_PROFILE_EMBEDDINGS = 8;

function normalize(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return Float32Array.from(vector, (value) => value / norm);
}

function average(vectors) {
  const result = new Float32Array(vectors[0].length);
  for (const vector of vectors) {
    for (let index = 0; index < result.length; index += 1) result[index] += vector[index];
  }
  return normalize(result);
}

function profileConsistency(vectors) {
  if (vectors.length < 2) return 1;
  const scores = [];
  for (let left = 0; left < vectors.length; left += 1) {
    for (let right = left + 1; right < vectors.length; right += 1) {
      scores.push(cosineSimilarity(vectors[left], vectors[right]));
    }
  }
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

export function mergeSpeakerProfileVectors(groups, options = {}) {
  const maximumProfiles = Math.max(4, Number(options.maximumProfiles) || 32);
  const candidates = (Array.isArray(groups) ? groups : []).flat()
    .filter((vector) => vector instanceof Float32Array && vector.length > 0);
  if (!candidates.length) throw new Error("합칠 화자 임베딩이 없습니다.");
  const dimensions = candidates[0].length;
  if (candidates.some((vector) => vector.length !== dimensions)) {
    throw new Error("화자 임베딩 차원이 서로 다릅니다.");
  }
  const unique = [];
  for (const vector of candidates) {
    if (!unique.some((existing) => cosineSimilarity(existing, vector) > 0.9999)) unique.push(normalize(vector));
  }
  const exemplarLimit = maximumProfiles - 1;
  const exemplars = unique.length <= exemplarLimit
    ? unique
    : Array.from({ length: exemplarLimit }, (_value, index) =>
      unique[Math.round(index * (unique.length - 1) / Math.max(1, exemplarLimit - 1))]);
  const consistency = profileConsistency(exemplars);
  return {
    vectors: [average(exemplars), ...exemplars],
    consistency,
    matchThreshold: Math.max(0.68, Math.min(0.82, consistency - 0.16))
  };
}

export function cosineSimilarity(left, right) {
  if (!left?.length || left.length !== right?.length) return -1;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

export function pcmRms(pcm) {
  if (!pcm.length) return 0;
  let sum = 0;
  for (const sample of pcm) {
    const normalized = sample / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / pcm.length);
}

export class SpeakerEmbeddingModel {
  constructor(session) {
    this.session = session;
  }

  static async create(cacheDirectory, configuredModelPath) {
    const modelPath = configuredModelPath
      ? path.resolve(configuredModelPath)
      : path.join(path.resolve(cacheDirectory), "wavlm-base-plus-sv-q8.onnx");
    let modelBytes;
    try {
      modelBytes = await readFile(modelPath);
    } catch (error) {
      if (configuredModelPath || error?.code !== "ENOENT") throw error;
      await mkdir(path.dirname(modelPath), { recursive: true });
      const response = await fetch(MODEL_URL);
      if (!response.ok) throw new Error(`화자 모델 다운로드 실패: HTTP ${response.status}`);
      modelBytes = Buffer.from(await response.arrayBuffer());
      const temporaryPath = `${modelPath}.partial-${process.pid}`;
      await writeFile(temporaryPath, modelBytes);
      await rename(temporaryPath, modelPath);
    }
    const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
    return new SpeakerEmbeddingModel(session);
  }

  async embed(pcm) {
    if (!(pcm instanceof Int16Array) || pcm.length < SAMPLE_RATE) {
      throw new Error("화자 임베딩에는 1초 이상의 16kHz PCM이 필요합니다.");
    }
    if (pcmRms(pcm) < 0.008) throw new Error("음성이 너무 작거나 말소리가 없습니다.");
    const audio = Float32Array.from(pcm, (sample) => sample / 32768);
    const input = new ort.Tensor("float32", audio, [1, audio.length]);
    const output = await this.session.run({ input_values: input });
    const embedding = output.embeddings ?? output.logits;
    if (!embedding?.data?.length) throw new Error("화자 임베딩을 생성하지 못했습니다.");
    return normalize(embedding.data);
  }

  async createProfile(pcm) {
    const windows = [];
    if (pcm.length <= WINDOW_SAMPLES) {
      windows.push({ pcm, start: 0, quality: analyzePcmQuality(pcm, SAMPLE_RATE) });
    } else {
      for (let start = 0; start + SAMPLE_RATE <= pcm.length; start += HOP_SAMPLES) {
        const window = pcm.subarray(start, Math.min(start + WINDOW_SAMPLES, pcm.length));
        windows.push({ pcm: window, start, quality: analyzePcmQuality(window, SAMPLE_RATE) });
      }
    }
    const selected = windows
      .filter(({ quality }) => quality.rms >= 0.008 && quality.voicedRatio >= 0.18)
      .sort((left, right) => right.quality.score - left.quality.score || left.start - right.start)
      .slice(0, MAX_PROFILE_EMBEDDINGS)
      .sort((left, right) => left.start - right.start);
    const embeddings = [];
    for (const window of selected) {
      embeddings.push(await this.embed(window.pcm));
    }
    if (!embeddings.length) throw new Error("등록 파일에서 충분한 말소리를 찾지 못했습니다.");
    const exemplars = embeddings;
    const consistency = profileConsistency(exemplars);
    if (exemplars.length >= 2 && consistency < 0.58) {
      throw new Error("등록 음성의 화자 특성이 일정하지 않습니다. 한 사람만 말하는 깨끗한 파일을 사용해 주세요.");
    }
    return {
      centroid: average(exemplars),
      exemplars,
      consistency,
      matchThreshold: Math.max(0.68, Math.min(0.82, consistency - 0.16))
    };
  }

  async compare(pcm, speakerProfiles) {
    if (pcmRms(pcm) < 0.008) return null;
    const embedding = await this.embed(pcm);
    return speakerProfiles.map((candidate) => {
      const profiles = candidate instanceof Float32Array ? [candidate] : candidate;
      const scores = profiles.map((profile) => cosineSimilarity(embedding, profile)).sort((left, right) => right - left);
      if (scores.length === 1) return scores[0];
      return scores[0] * 0.7 + scores[1] * 0.3;
    });
  }
}

let modelPromise;

export function getSpeakerEmbeddingModel(cacheDirectory, modelPath) {
  modelPromise ||= SpeakerEmbeddingModel.create(cacheDirectory, modelPath);
  return modelPromise;
}

export const speakerModelInfo = { id: MODEL_ID, url: MODEL_URL, sampleRate: SAMPLE_RATE, dimensions: 512 };
