import assert from "node:assert/strict";
import test from "node:test";
import { createTurnBuilder } from "../lib/livemap-turn-builder.mjs";

function seg(speaker, start, end, text) {
  return { speaker, start, end, text };
}

test("merges consecutive same-speaker segments within the gap into one turn", () => {
  const builder = createTurnBuilder();
  // gap = 2.5 - 2.0 = 0.5 < 1.25 -> merge
  assert.equal(builder.push(seg("민수", 0, 2, "첫 문장")).finalizedTurn, null);
  assert.equal(builder.push(seg("민수", 2, 2.5, "이어지는 문장")).finalizedTurn, null);
  const { finalizedTurn } = builder.flush();
  assert.deepEqual(finalizedTurn, { turnId: "turn-1", speaker: "민수", text: "첫 문장 이어지는 문장", start: 0, end: 2.5 });
});

test("a gap >= 1.25s splits into a new turn", () => {
  const builder = createTurnBuilder();
  assert.equal(builder.push(seg("민수", 0, 1, "먼저")).finalizedTurn, null);
  // gap = 2.5 - 1.0 = 1.5 >= 1.25 -> split; the previous turn is returned
  const { finalizedTurn } = builder.push(seg("민수", 2.5, 3, "나중"));
  assert.deepEqual(finalizedTurn, { turnId: "turn-1", speaker: "민수", text: "먼저", start: 0, end: 1 });
  assert.deepEqual(builder.flush().finalizedTurn, { turnId: "turn-2", speaker: "민수", text: "나중", start: 2.5, end: 3 });
});

test("boundary at exactly the gap splits (strict less-than)", () => {
  const builder = createTurnBuilder();
  builder.push(seg("민수", 0, 1, "가"));
  // gap = 2.25 - 1.0 = 1.25, not < 1.25 -> split
  const { finalizedTurn } = builder.push(seg("민수", 2.25, 3, "나"));
  assert.equal(finalizedTurn.turnId, "turn-1");
});

test("a speaker change splits even within the gap", () => {
  const builder = createTurnBuilder();
  builder.push(seg("민수", 0, 1, "질문"));
  const { finalizedTurn } = builder.push(seg("지현", 1.1, 2, "대답"));
  assert.deepEqual(finalizedTurn, { turnId: "turn-1", speaker: "민수", text: "질문", start: 0, end: 1 });
  assert.equal(builder.flush().finalizedTurn.speaker, "지현");
});

test("blank and whitespace-only segments are skipped", () => {
  const builder = createTurnBuilder();
  assert.equal(builder.push(seg("민수", 0, 1, "   ")).finalizedTurn, null);
  assert.equal(builder.push(seg("민수", 1, 2, "\t\n")).finalizedTurn, null);
  assert.equal(builder.push(seg("민수", 2, 3, "실제")).finalizedTurn, null);
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
