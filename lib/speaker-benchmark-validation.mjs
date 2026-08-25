import { recordingEnvelopeSimilarity } from "./speaker-verification.mjs";

const DEFAULT_DUPLICATE_AUDIO_THRESHOLD = 0.985;

export function benchmarkDuplicateAudioThreshold(value) {
  const threshold = Number(value);
  return Number.isFinite(threshold) && threshold > 0 && threshold <= 1
    ? threshold
    : DEFAULT_DUPLICATE_AUDIO_THRESHOLD;
}

export function assertIndependentBenchmarkRecordings(enrollments, probes, options = {}) {
  const threshold = benchmarkDuplicateAudioThreshold(options.threshold);
  const recordings = [...enrollments, ...probes];
  let closestPair = null;

  for (let rightIndex = 1; rightIndex < recordings.length; rightIndex += 1) {
    const right = recordings[rightIndex];
    for (let leftIndex = 0; leftIndex < rightIndex; leftIndex += 1) {
      const left = recordings[leftIndex];
      const similarity = recordingEnvelopeSimilarity(left.pcm, right.pcm);
      if (similarity == null) continue;
      if (!closestPair || similarity > closestPair.similarity) {
        closestPair = { left: left.file, right: right.file, similarity };
      }
      if (similarity >= threshold) {
        throw new Error(`${right.file}: ${left.file}의 재인코딩 또는 편집본으로 보입니다. 모든 등록 및 검증 파일은 독립 녹음이어야 합니다.`);
      }
    }
  }

  return { threshold, recordingCount: recordings.length, closestPair };
}
