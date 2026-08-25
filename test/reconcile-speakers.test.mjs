import test from "node:test";
import assert from "node:assert/strict";
import { reconcileTranscriptSpeakers } from "../lib/reconcile-speakers.mjs";

test("reconciles diarized labels with locally registered speaker profiles", async () => {
  const transcript = {
    speakers: ["A", "B"],
    segments: [
      { id: "a", speaker: "A", start: 0, end: 2, text: "안녕하세요" },
      { id: "b", speaker: "B", start: 2, end: 4, text: "반갑습니다" }
    ]
  };
  const speakers = [
    { id: "one", name: "민수", profiles: [new Float32Array([1])] },
    { id: "two", name: "지수", profiles: [new Float32Array([1])] }
  ];
  let call = 0;
  const model = { compare: async () => (++call === 1 ? [0.91, 0.3] : [0.2, 0.9]) };
  const result = await reconcileTranscriptSpeakers(transcript, new Int16Array(64_000), speakers, model);
  assert.deepEqual(result.speakers, ["민수", "지수"]);
  assert.deepEqual(result.segments.map(({ speaker }) => speaker), ["민수", "지수"]);
  assert.ok(result.segments.every(({ known }) => known));
});

test("keeps provider labels when local evidence is insufficient", async () => {
  const transcript = { speakers: ["A"], segments: [{ speaker: "A", start: 0, end: 0.5, text: "짧은 말" }] };
  const result = await reconcileTranscriptSpeakers(transcript, new Int16Array(16_000), [{ id: "one", name: "민수", profiles: [] }], { compare: async () => [0.95] });
  assert.equal(result.segments[0].speaker, "A");
});

test("combines short turns from one provider cluster into one model decision", async () => {
  const transcript = {
    speakers: ["A"],
    segments: [
      { speaker: "A", start: 0, end: 0.6, text: "첫째" },
      { speaker: "A", start: 1, end: 1.6, text: "둘째" },
      { speaker: "A", start: 2, end: 2.6, text: "셋째" }
    ]
  };
  const speakers = [{ id: "one", name: "민수", profiles: [new Float32Array([1])] }];
  let comparedSamples = 0;
  let calls = 0;
  const model = { compare: async (audio) => { calls += 1; comparedSamples = audio.length; return [0.91]; } };
  const result = await reconcileTranscriptSpeakers(transcript, new Int16Array(48_000), speakers, model);
  assert.equal(calls, 1);
  assert.equal(comparedSamples, 28_800);
  assert.ok(result.segments.every(({ speaker, known }) => speaker === "민수" && known));
});

test("preserves a provider-known speaker unless local conflicting evidence is strong", async () => {
  const transcript = {
    speakers: ["민수"],
    segments: [{ speaker: "민수", start: 0, end: 2, text: "등록 참조로 확인됨" }]
  };
  const speakers = [
    { id: "one", name: "민수", profiles: [new Float32Array([1])] },
    { id: "two", name: "지수", profiles: [new Float32Array([1])] }
  ];
  const ambiguousConflict = await reconcileTranscriptSpeakers(
    transcript, new Int16Array(32_000), speakers, { compare: async () => [0.75, 0.79] }
  );
  assert.equal(ambiguousConflict.segments[0].speaker, "민수");
  assert.equal(ambiguousConflict.segments[0].known, true);
  assert.equal(ambiguousConflict.segments[0].confidence, null);

  const strongConflict = await reconcileTranscriptSpeakers(
    transcript, new Int16Array(32_000), speakers, { compare: async () => [0.2, 0.94] }
  );
  assert.equal(strongConflict.segments[0].speaker, "지수");
  assert.equal(strongConflict.segments[0].confidence, 0.94);
});
