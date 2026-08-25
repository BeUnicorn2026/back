import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePcmQuality, isSpeakerInferenceQuality } from "../lib/audio-quality.mjs";
import { assertIndependentBenchmarkRecordings } from "../lib/speaker-benchmark-validation.mjs";
import { getSpeakerEmbeddingModel, mergeSpeakerProfileVectors, speakerInferenceInfo } from "../lib/speaker-embedding-model.mjs";
import { assessBenchmarkCoverage, calibrateSpeakerThreshold, evaluateSpeakerTrials } from "../lib/speaker-evaluation.mjs";

const argumentsList = process.argv.slice(2);
const valueAfter = (name) => {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : null;
};

if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
  console.log(`Usage: npm run benchmark:speakers -- --manifest <dataset.json> [--output <report.json>] [--validate-only]

Manifest:
{
  "speakers": [{ "id": "alice", "name": "Alice", "enrollment": ["audio/alice-enroll.wav"] }],
  "probes": [
    { "file": "audio/alice-test.wav", "speakerId": "alice" },
    { "file": "audio/unknown.wav", "speakerId": null }
  ],
  "threshold": 0.72,
  "margin": 0.04,
  "duplicateAudioThreshold": 0.985
}

Enrollment and probe files must be independent recordings. Re-encoded or edited copies are rejected.
--validate-only checks the manifest, audio quality and recording independence without loading WavLM.
Paths are resolved relative to the manifest.`);
  process.exit(0);
}

const manifestPath = valueAfter("--manifest");
if (!manifestPath) throw new Error("--manifest 경로가 필요합니다. --help에서 형식을 확인하세요.");
const absoluteManifestPath = path.resolve(manifestPath);
const manifestDirectory = path.dirname(absoluteManifestPath);
const manifest = JSON.parse(await readFile(absoluteManifestPath, "utf8"));
if (!Array.isArray(manifest.speakers) || !manifest.speakers.length || !Array.isArray(manifest.probes) || !manifest.probes.length) {
  throw new Error("manifest에는 speakers와 probes가 각각 한 개 이상 필요합니다.");
}
const speakerIds = new Set();
for (const speaker of manifest.speakers) {
  if (!speaker.id || !speaker.name || !Array.isArray(speaker.enrollment) || !speaker.enrollment.length) {
    throw new Error("각 speaker에는 id, name, enrollment 파일 목록이 필요합니다.");
  }
  if (speakerIds.has(speaker.id)) throw new Error(`speaker id ${speaker.id}가 중복되었습니다.`);
  speakerIds.add(speaker.id);
}
for (const probe of manifest.probes) {
  if (!probe.file) throw new Error("각 probe에는 file이 필요합니다.");
  if (probe.speakerId != null && !speakerIds.has(probe.speakerId)) {
    throw new Error(`${probe.file}: speakerId ${probe.speakerId}가 speakers에 없습니다.`);
  }
}

function decodeToPcm(filePath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", filePath, "-vn",
      "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"
    ]);
    const chunks = [];
    let errorText = "";
    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => { errorText += chunk.toString(); });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${filePath}: ${errorText.trim() || "디코딩 실패"}`));
      const buffer = Buffer.concat(chunks);
      resolve(new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2)));
    });
  });
}

const enrollmentQuality = [];
const enrollmentFiles = new Set();
const enrollmentRecordings = [];
for (const speaker of manifest.speakers) {
  for (const relativeFile of speaker.enrollment) {
    const file = path.resolve(manifestDirectory, relativeFile);
    if (enrollmentFiles.has(file)) throw new Error(`${relativeFile}: 등록 파일이 중복되었습니다.`);
    enrollmentFiles.add(file);
    const pcm = await decodeToPcm(file);
    const quality = analyzePcmQuality(pcm);
    if (!quality.usable) throw new Error(`${relativeFile}: ${quality.warnings[0] || "등록 품질 부족"}`);
    enrollmentRecordings.push({ speakerId: speaker.id, file: relativeFile, pcm });
    enrollmentQuality.push({ speakerId: speaker.id, file: relativeFile, quality });
  }
}

const probeQuality = [];
const probeRecordings = [];
for (const probe of manifest.probes) {
  const file = path.resolve(manifestDirectory, probe.file);
  if (enrollmentFiles.has(file)) throw new Error(`${probe.file}: 등록과 검증에 같은 파일을 사용할 수 없습니다.`);
  const pcm = await decodeToPcm(file);
  const quality = analyzePcmQuality(pcm);
  if (!isSpeakerInferenceQuality(quality)) throw new Error(`${probe.file}: ${quality.warnings[0] || "검증 품질 부족"}`);
  probeRecordings.push({ file: probe.file, speakerId: probe.speakerId ?? null, pcm });
  probeQuality.push({ file: probe.file, quality });
}

const independence = assertIndependentBenchmarkRecordings(enrollmentRecordings, probeRecordings, {
  threshold: manifest.duplicateAudioThreshold
});
const validation = {
  valid: true,
  dataset: { speakers: manifest.speakers.length, enrollments: enrollmentRecordings.length, probes: probeRecordings.length },
  independence,
  enrollmentQuality,
  probeQuality
};
const outputPath = valueAfter("--output");
if (argumentsList.includes("--validate-only")) {
  const serializedValidation = `${JSON.stringify(validation, null, 2)}\n`;
  if (outputPath) await writeFile(path.resolve(outputPath), serializedValidation);
  process.stdout.write(serializedValidation);
  process.exit(0);
}

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const model = await getSpeakerEmbeddingModel(
  process.env.SPEAKER_MODEL_CACHE || path.join(projectDirectory, ".cache", "speaker-models"),
  process.env.SPEAKER_MODEL_PATH || ""
);
const speakers = [];
for (const speaker of manifest.speakers) {
  const profiles = [];
  for (const enrollment of enrollmentRecordings.filter(({ speakerId }) => speakerId === speaker.id)) {
    const profile = await model.createProfile(enrollment.pcm);
    profiles.push(profile.centroid, ...profile.exemplars);
    const qualityEntry = enrollmentQuality.find(({ speakerId, file }) => speakerId === speaker.id && file === enrollment.file);
    if (qualityEntry) qualityEntry.consistency = profile.consistency;
  }
  const merged = mergeSpeakerProfileVectors([profiles]);
  speakers.push({
    id: speaker.id,
    name: speaker.name,
    profiles: merged.vectors,
    enrollmentConsistency: merged.consistency,
    matchThreshold: merged.matchThreshold
  });
}

const trials = [];
for (const probe of probeRecordings) {
  const scores = await model.compare(probe.pcm, speakers.map(({ profiles }) => profiles), { maximumEmbeddings: 3 });
  if (!scores) throw new Error(`${probe.file}: 말소리가 부족해 비교하지 못했습니다.`);
  trials.push({ file: probe.file, expectedSpeakerId: probe.speakerId, scores });
}

const threshold = Number(manifest.threshold ?? 0.72);
const margin = Number(manifest.margin ?? 0.04);
const coverage = assessBenchmarkCoverage(trials, speakers, Number(manifest.minimumProbesPerClass) || 5);
const calibration = coverage.ready
  ? calibrateSpeakerThreshold(trials, speakers, {
    minimum: Number(manifest.calibration?.minimumThreshold ?? 0.55),
    maximum: Number(manifest.calibration?.maximumThreshold ?? 0.9),
    step: Number(manifest.calibration?.thresholdStep ?? 0.01),
    minimumMargin: Number(manifest.calibration?.minimumMargin ?? 0.02),
    maximumMargin: Number(manifest.calibration?.maximumMargin ?? 0.12),
    marginStep: Number(manifest.calibration?.marginStep ?? 0.01)
  })
  : { ready: false, reason: "보정값을 제안하려면 coverage 경고를 먼저 해소해야 합니다." };
const report = {
  generatedAt: new Date().toISOString(),
  model: "Xenova/wavlm-base-plus-sv",
  inference: speakerInferenceInfo,
  dataset: { speakers: speakers.length, probes: trials.length },
  validation,
  coverage,
  enrollmentQuality,
  probeQuality,
  current: evaluateSpeakerTrials(trials, speakers, { threshold, margin }),
  calibration
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(path.resolve(outputPath), serialized);
process.stdout.write(serialized);
