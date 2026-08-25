import assert from "node:assert/strict";
import test from "node:test";
import { SpeakerAudioAccumulator } from "../lib/speaker-audio-accumulator.mjs";

const pcm = (length, offset = 0) => Int16Array.from({ length }, (_value, index) => offset + index + 1);

test("combines short utterances from the same diarized speaker before inference", () => {
  const accumulator = new SpeakerAudioAccumulator({
    sampleRate: 10, minimumSeconds: 1.5, analysisIntervalSeconds: 0.5, maximumSeconds: 3
  });
  assert.equal(accumulator.add("0", pcm(8), { start: 0, end: 0.8 }), null);
  const evidence = accumulator.add("0", pcm(8, 8), { start: 1, end: 1.8 });
  assert.equal(evidence.pcm.length, 16);
  assert.equal(evidence.accumulatedSeconds, 1.6);
  assert.equal(evidence.newEvidenceSeconds, 1.6);
});

test("does not count overlapping finalized audio twice", () => {
  const accumulator = new SpeakerAudioAccumulator({
    sampleRate: 10, minimumSeconds: 1, analysisIntervalSeconds: 0.5, maximumSeconds: 3
  });
  assert.equal(accumulator.add("0", pcm(8), { start: 0, end: 0.8 }), null);
  const evidence = accumulator.add("0", pcm(8, 4), { start: 0.4, end: 1.2 });
  assert.equal(evidence.pcm.length, 12);
  assert.deepEqual([...evidence.pcm], [...pcm(8), ...pcm(4, 8)]);
});

test("keeps speaker clusters isolated and bounds retained audio", () => {
  const accumulator = new SpeakerAudioAccumulator({
    sampleRate: 10, minimumSeconds: 1, analysisIntervalSeconds: 0.5, maximumSeconds: 2
  });
  assert.equal(accumulator.add("0", pcm(6), { start: 0, end: 0.6 }), null);
  assert.equal(accumulator.add("1", pcm(6, 100), { start: 0.6, end: 1.2 }), null);
  const first = accumulator.add("0", pcm(16, 10), { start: 1.2, end: 2.8 });
  assert.equal(first.pcm.length, 20);
  assert.ok([...first.pcm].every((sample) => sample < 100));
  const second = accumulator.add("1", pcm(5, 106), { start: 2.8, end: 3.3 });
  assert.ok([...second.pcm].every((sample) => sample > 100));
});

test("keeps the newest tail when one utterance exceeds the retention window", () => {
  const accumulator = new SpeakerAudioAccumulator({
    sampleRate: 10, minimumSeconds: 1, analysisIntervalSeconds: 0.5, maximumSeconds: 2
  });
  const evidence = accumulator.add("0", pcm(35), { start: 0, end: 3.5 });
  assert.equal(evidence.pcm.length, 20);
  assert.deepEqual([...evidence.pcm], [...pcm(35).subarray(15)]);
  assert.equal(evidence.newEvidenceSeconds, 3.5);
});
