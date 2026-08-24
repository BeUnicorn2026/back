import { readFile } from "node:fs/promises";
import { analyzePcmQuality } from "../lib/audio-quality.mjs";
import { SpeakerEmbeddingModel } from "../lib/speaker-embedding-model.mjs";

const [pcmPath, modelPath] = process.argv.slice(2);
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: node scripts/verify-speaker-model.mjs <16k-mono.pcm> [model.onnx]");
  process.exit(0);
}
if (!pcmPath) {
  console.error("Usage: node scripts/verify-speaker-model.mjs <16k-mono.pcm> [model.onnx]");
  process.exit(2);
}

const buffer = await readFile(pcmPath);
const pcm = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
const model = await SpeakerEmbeddingModel.create(".cache/speaker-models", modelPath);
const profile = await model.createProfile(pcm);
const norm = Math.sqrt(profile.centroid.reduce((sum, value) => sum + value * value, 0));
const [selfScore] = await model.compare(pcm, [[profile.centroid, ...profile.exemplars]], { maximumEmbeddings: 3 });
console.log(JSON.stringify({
  dimensions: profile.centroid.length,
  norm,
  exemplars: profile.exemplars.length,
  consistency: profile.consistency,
  matchThreshold: profile.matchThreshold,
  selfScore,
  quality: analyzePcmQuality(pcm)
}, null, 2));
