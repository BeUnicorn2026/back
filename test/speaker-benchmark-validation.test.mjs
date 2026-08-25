import assert from "node:assert/strict";
import test from "node:test";
import {
  assertIndependentBenchmarkRecordings,
  benchmarkDuplicateAudioThreshold
} from "../lib/speaker-benchmark-validation.mjs";

function makePcm({ frequency = 180, seed = 1 } = {}) {
  const pcm = new Int16Array(16_000 * 6);
  let random = seed;
  let envelope = 1;
  for (let index = 0; index < pcm.length; index += 1) {
    if (index % 320 === 0) {
      random = (random * 1_664_525 + 1_013_904_223) >>> 0;
      envelope = 0.2 + 0.8 * (random / 0xffff_ffff);
    }
    pcm[index] = Math.round(12_000 * envelope * Math.sin((2 * Math.PI * frequency * index) / 16_000));
  }
  return pcm;
}

test("uses a safe duplicate threshold when configuration is invalid", () => {
  assert.equal(benchmarkDuplicateAudioThreshold(undefined), 0.985);
  assert.equal(benchmarkDuplicateAudioThreshold(0), 0.985);
  assert.equal(benchmarkDuplicateAudioThreshold(0.99), 0.99);
});

test("rejects copied recordings anywhere in a benchmark dataset", () => {
  const original = makePcm();
  const copied = Int16Array.from(original, (sample) => Math.round(sample * 0.8));
  assert.throws(() => assertIndependentBenchmarkRecordings(
    [{ file: "enroll.wav", pcm: original }],
    [{ file: "probe.mp3", pcm: copied }]
  ), /독립 녹음/);
});

test("accepts independently generated recordings and reports the closest pair", () => {
  const result = assertIndependentBenchmarkRecordings(
    [{ file: "alice.wav", pcm: makePcm({ frequency: 180 }) }],
    [{ file: "bob.wav", pcm: makePcm({ frequency: 263, seed: 91 }) }]
  );
  assert.equal(result.recordingCount, 2);
  assert.equal(result.closestPair.left, "alice.wav");
  assert.equal(result.closestPair.right, "bob.wav");
  assert.ok(result.closestPair.similarity < result.threshold);
});
