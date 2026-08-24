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
