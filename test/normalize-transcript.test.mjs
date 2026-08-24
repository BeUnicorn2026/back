import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTranscript } from "../lib/normalize-transcript.mjs";

test("maps provider speaker IDs to A, B, C in order of appearance", () => {
  const result = normalizeTranscript({
    duration: 8.4,
    segments: [
      { id: "1", speaker: "speaker_2", start: 0, end: 2, text: "안녕하세요." },
      { id: "2", speaker: "speaker_9", start: 2, end: 5, text: "반갑습니다." },
      { id: "3", speaker: "speaker_2", start: 5, end: 7, text: "시작할까요?" },
      { id: "4", speaker: "speaker_5", start: 7, end: 8.4, text: "좋아요." }
    ]
  });

  assert.deepEqual(result.speakers, ["A", "B", "C"]);
  assert.deepEqual(result.segments.map(({ speaker }) => speaker), ["A", "B", "A", "C"]);
});

test("drops empty segments and tolerates missing metadata", () => {
  const result = normalizeTranscript({ segments: [{ speaker: "x", text: "  " }, { text: " 내용 " }] });
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0].text, "내용");
  assert.equal(result.segments[0].speaker, "A");
});

test("preserves registered speaker names from known-speaker transcription", () => {
  const result = normalizeTranscript({
    duration: 2,
    segments: [{ id: "one", speaker: "민수", start: 0, end: 2, text: "안녕하세요" }]
  }, { knownSpeakers: ["민수"] });

  assert.equal(result.segments[0].speaker, "민수");
  assert.deepEqual(result.speakers, ["민수"]);
});
