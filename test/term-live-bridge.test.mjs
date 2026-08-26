import assert from "node:assert/strict";
import test from "node:test";
import { createNoopTermLiveBridge, createTermLiveBridge } from "../lib/term-live-bridge.mjs";
import { normalizeTermKey } from "../lib/knowledge-personalization.mjs";

function fakeExtraction(responses) {
  const calls = [];
  return {
    calls,
    async extract(input) {
      calls.push(input);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return { terms: next || [] };
    }
  };
}

function openFilter() {
  return { async familiarTerms() { return { familiarKeys: new Set(), source: "openai" }; } };
}

function participant(userId, overrides = {}) {
  const messages = [];
  return {
    userId,
    introduction: overrides.introduction || `${userId}입니다`,
    knownTerms: overrides.knownTerms || [],
    messages,
    send(payload) { messages.push(payload); }
  };
}

const TERM_A = { term: "파인튜닝", surface: "파인튜닝으로", aliases: ["fine-tuning"], definition: "추가 학습 작업입니다." };
const TERM_B = { term: "임베딩", surface: "임베딩을", aliases: [], definition: "의미 벡터입니다." };

test("noop bridge is inert and safe", async () => {
  const bridge = createNoopTermLiveBridge();
  bridge.handleFinalSegment({ text: "아무거나" });
  assert.equal(await bridge.finalize(), null);
  assert.equal(bridge.disabled, true);
});

test("two segments form one chunk, and new terms are pushed as term_batch", async () => {
  const extraction = fakeExtraction([[TERM_A]]);
  const member = participant("user-a");
  const bridge = createTermLiveBridge({
    extraction, filter: openFilter(), participants: () => [member], meetingTopic: "기획 회의"
  });
  bridge.handleFinalSegment({ text: "기존 파이프라인이 있습니다", start: 0, end: 2, speaker: "김AI" });
  bridge.handleFinalSegment({ text: "파인튜닝으로 바꾸죠", start: 2.5, end: 4 });
  await bridge.finalize();
  assert.equal(extraction.calls.length, 1);
  assert.equal(extraction.calls[0].chunk, "기존 파이프라인이 있습니다 파인튜닝으로 바꾸죠");
  assert.equal(extraction.calls[0].meetingTopic, "기획 회의");
  assert.equal(member.messages.length, 1);
  assert.equal(member.messages[0].type, "term_batch");
  const pushed = member.messages[0].payload.terms;
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].term, "파인튜닝");
  assert.equal(pushed[0].surface, "파인튜닝으로");
  assert.equal(pushed[0].speaker, "김AI");
  assert.match(pushed[0].conceptId, /^concept_[a-f0-9]{32}$/);
});

test("terms and aliases are defined once per session and fed back to Stage 1", async () => {
  const extraction = fakeExtraction([
    [TERM_A],
    [{ ...TERM_A, term: "fine-tuning", aliases: ["파인튜닝"] }, TERM_B]
  ]);
  const member = participant("user-a");
  const bridge = createTermLiveBridge({ extraction, filter: openFilter(), participants: () => [member] });
  bridge.handleFinalSegment({ text: "파인튜닝 얘기 첫 문장." });
  bridge.handleFinalSegment({ text: "파인튜닝 얘기 둘째 문장." });
  bridge.handleFinalSegment({ text: "fine-tuning과 임베딩 얘기." });
  bridge.handleFinalSegment({ text: "계속 이어집니다." });
  await bridge.finalize();
  assert.equal(extraction.calls.length, 2);
  assert.ok(extraction.calls[1].definedTerms.includes("파인튜닝"));
  assert.ok(extraction.calls[1].definedTerms.includes("fine-tuning"));
  // 두 번째 청크에서 별칭으로 재등장한 파인튜닝은 걸러지고 임베딩만 새로 푸시된다.
  assert.equal(member.messages.length, 2);
  assert.deepEqual(member.messages[1].payload.terms.map(({ term }) => term), ["임베딩"]);
});

test("Stage 2 hides familiar terms per participant; failures fail open", async () => {
  const extraction = fakeExtraction([[TERM_A, TERM_B]]);
  const expert = participant("data-researcher");
  const novice = participant("finance");
  const broken = participant("broken-filter");
  const filter = {
    async familiarTerms({ userId }) {
      if (userId === "data-researcher") {
        return { familiarKeys: new Set([normalizeTermKey("임베딩"), normalizeTermKey("파인튜닝")]) };
      }
      if (userId === "broken-filter") throw new Error("filter down");
      return { familiarKeys: new Set() };
    }
  };
  const bridge = createTermLiveBridge({
    extraction, filter, participants: () => [expert, novice, broken]
  });
  bridge.handleFinalSegment({ text: "파인튜닝. 임베딩." });
  await bridge.finalize();
  assert.equal(expert.messages.length, 0);
  assert.deepEqual(novice.messages[0].payload.terms.map(({ term }) => term), ["파인튜닝", "임베딩"]);
  assert.deepEqual(broken.messages[0].payload.terms.map(({ term }) => term), ["파인튜닝", "임베딩"]);
});

test("explicit knownTerms hide a term across notation and alias variants", async () => {
  // "fine tuning"은 별칭 fine-tuning과 같은 정규화 키이므로 대표형 파인튜닝도 숨긴다.
  const aliasKnown = participant("user-a", { knownTerms: ["fine tuning"] });
  const first = createTermLiveBridge({
    extraction: fakeExtraction([[TERM_A]]), filter: openFilter(), participants: () => [aliasKnown]
  });
  first.handleFinalSegment({ text: "파인튜닝 이야기입니다. 계속하죠." });
  await first.finalize();
  assert.equal(aliasKnown.messages.length, 0);
  const spacedKnown = participant("user-b", { knownTerms: ["파인 튜닝"] });
  const second = createTermLiveBridge({
    extraction: fakeExtraction([[TERM_A]]), filter: openFilter(), participants: () => [spacedKnown]
  });
  second.handleFinalSegment({ text: "파인튜닝 이야기입니다. 계속하죠." });
  await second.finalize();
  assert.equal(spacedKnown.messages.length, 0);
});

test("a failed extraction discards only that chunk and the stream continues", async () => {
  const extraction = fakeExtraction([new Error("timeout"), [TERM_B]]);
  const member = participant("user-a");
  const events = [];
  const bridge = createTermLiveBridge({
    extraction, filter: openFilter(), participants: () => [member], log: (entry) => events.push(entry)
  });
  bridge.handleFinalSegment({ text: "첫 청크 문장 하나. 문장 둘." });
  bridge.handleFinalSegment({ text: "둘째 청크 문장 하나. 임베딩 등장." });
  await bridge.finalize();
  assert.equal(extraction.calls.length, 2);
  assert.deepEqual(events, [{ event: "term_chunk_discarded" }]);
  assert.equal(member.messages.length, 1);
  assert.equal(member.messages[0].payload.terms[0].term, "임베딩");
});

test("finalize flushes a pending single-sentence chunk; replay and dispose are inert", async () => {
  const extraction = fakeExtraction([[TERM_B]]);
  const member = participant("user-a");
  const bridge = createTermLiveBridge({ extraction, filter: openFilter(), participants: () => [member] });
  bridge.replayFinalSegment({ text: "과거 기록은 무시된다. 임베딩 포함이라도." });
  bridge.handleFinalSegment({ text: "임베딩 한 문장뿐" });
  await bridge.finalize();
  assert.equal(extraction.calls.length, 1);
  assert.equal(member.messages.length, 1);
  bridge.handleFinalSegment({ text: "종료 후 세그먼트는 무시. 무시." });
  await bridge.dispose();
  assert.equal(extraction.calls.length, 1);
});

test("participant snapshot failures never break chunk processing", async () => {
  const extraction = fakeExtraction([[TERM_A]]);
  const bridge = createTermLiveBridge({
    extraction, filter: openFilter(), participants: () => { throw new Error("no session"); }
  });
  bridge.handleFinalSegment({ text: "파인튜닝. 임베딩." });
  await bridge.finalize();
  assert.equal(extraction.calls.length, 1);
});
