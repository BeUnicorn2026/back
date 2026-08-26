import assert from "node:assert/strict";
import test from "node:test";
import { createTurnBuilder } from "../lib/livemap-turn-builder.mjs";

function seg(speaker, start, end, text) {
  return { speaker, start, end, text };
}

test("same-speaker segments keep merging even across long silence gaps", () => {
  const builder = createTurnBuilder();
  assert.deepEqual(builder.push(seg("민수", 0, 2, "첫 문장")).finalizedTurns, []);
  // 예전 1.25초 gap 규칙이라면 여기서 끊겼을 5초 침묵도 병합된다.
  assert.deepEqual(builder.push(seg("민수", 7, 8, "이어지는 문장")).finalizedTurns, []);
  const { finalizedTurn } = builder.flush();
  assert.deepEqual(finalizedTurn, { turnId: "turn-1", speaker: "민수", text: "첫 문장 이어지는 문장", start: 0, end: 8 });
});

test("crossing the word threshold (30 어절) finalizes at the segment boundary", () => {
  const builder = createTurnBuilder();
  const fifteenWords = Array.from({ length: 15 }, (_, i) => `어절${i}`).join(" ");
  assert.deepEqual(builder.push(seg("민수", 0, 3, fifteenWords)).finalizedTurns, []);
  const { finalizedTurns } = builder.push(seg("민수", 3, 6, fifteenWords));
  assert.equal(finalizedTurns.length, 1);
  assert.equal(finalizedTurns[0].turnId, "turn-1");
  assert.equal(finalizedTurns[0].text.split(" ").length, 30);
  assert.equal(builder.flush().finalizedTurn, null);
});

test("crossing the syllable threshold (80음절) finalizes immediately", () => {
  const builder = createTurnBuilder();
  const { finalizedTurns } = builder.push(seg("민수", 0, 4, "가".repeat(80)));
  assert.equal(finalizedTurns.length, 1);
  assert.equal(finalizedTurns[0].speaker, "민수");
});

test("syllables count characters without whitespace", () => {
  const builder = createTurnBuilder({ maxSyllables: 10 });
  // 공백 포함 11자이지만 음절은 9개라 임계 미달이다.
  assert.deepEqual(builder.push(seg("민수", 0, 1, "가나다 라마바 사아자")).finalizedTurns, []);
  assert.equal(builder.push(seg("민수", 1, 2, "차")).finalizedTurns.length, 1);
});

test("crossing the duration threshold (20초) finalizes the turn", () => {
  const builder = createTurnBuilder();
  assert.deepEqual(builder.push(seg("민수", 0, 10, "짧게")).finalizedTurns, []);
  const { finalizedTurns } = builder.push(seg("민수", 19, 21, "이어서"));
  assert.equal(finalizedTurns.length, 1);
  assert.deepEqual(finalizedTurns[0], { turnId: "turn-1", speaker: "민수", text: "짧게 이어서", start: 0, end: 21 });
});

test("a speaker change always finalizes the previous turn", () => {
  const builder = createTurnBuilder();
  builder.push(seg("민수", 0, 1, "질문"));
  const { finalizedTurns } = builder.push(seg("지현", 1.1, 2, "대답"));
  assert.deepEqual(finalizedTurns, [{ turnId: "turn-1", speaker: "민수", text: "질문", start: 0, end: 1 }]);
  assert.equal(builder.flush().finalizedTurn.speaker, "지현");
});

test("a speaker change into an over-threshold segment finalizes two turns at once", () => {
  const builder = createTurnBuilder();
  builder.push(seg("민수", 0, 1, "짧은 질문"));
  const { finalizedTurns } = builder.push(seg("지현", 1.1, 5, "가".repeat(80)));
  assert.equal(finalizedTurns.length, 2);
  assert.equal(finalizedTurns[0].speaker, "민수");
  assert.equal(finalizedTurns[1].speaker, "지현");
  assert.equal(builder.flush().finalizedTurn, null);
});

test("blank and whitespace-only segments are skipped", () => {
  const builder = createTurnBuilder();
  assert.deepEqual(builder.push(seg("민수", 0, 1, "   ")).finalizedTurns, []);
  assert.deepEqual(builder.push(seg("민수", 1, 2, "\t\n")).finalizedTurns, []);
  assert.deepEqual(builder.push(seg("민수", 2, 3, "실제")).finalizedTurns, []);
  assert.deepEqual(builder.flush().finalizedTurn, { turnId: "turn-1", speaker: "민수", text: "실제", start: 2, end: 3 });
});

test("a blank speaker defaults to 화자 and text is trimmed", () => {
  const builder = createTurnBuilder();
  builder.push(seg("  ", 0, 1, "  안건  "));
  assert.deepEqual(builder.flush().finalizedTurn, { turnId: "turn-1", speaker: "화자", text: "안건", start: 0, end: 1 });
});

test("flush on an empty builder returns null", () => {
  const builder = createTurnBuilder();
  assert.equal(builder.flush().finalizedTurn, null);
});
