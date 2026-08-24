import assert from "node:assert/strict";
import test from "node:test";
import {
  applyKnowledgeEvidence, conceptIdFor, decayedKnowledgeState, explanationScore,
  initialKnowledgeState, knowledgeView, normalizeConceptLabel, shouldExplainConcept
} from "../lib/knowledge-twin.mjs";

const now = "2026-08-24T00:00:00.000Z";

test("normalizes equivalent concept labels into a stable private identifier", () => {
  assert.equal(normalizeConceptLabel("  임베딩  모델 "), "임베딩 모델");
  assert.equal(conceptIdFor("Embedding"), conceptIdFor("ＥＭＢＥＤＤＩＮＧ"));
  assert.match(conceptIdFor("임베딩"), /^concept_[a-f0-9]{32}$/);
  assert.equal(conceptIdFor("  "), "");
});

test("explicit user corrections anchor mastery while weak observations move it gradually", () => {
  const initial = initialKnowledgeState({ now });
  const opened = applyKnowledgeEvidence(initial, "card_open", { now }).state;
  assert.ok(knowledgeView(opened).pKnown < 0.35);
  assert.ok(knowledgeView(opened).pKnown > 0.3);

  const known = applyKnowledgeEvidence(opened, "mark_known", { now }).state;
  assert.ok(Math.abs(knowledgeView(known).pKnown - 0.92) < 0.001);
  const corrected = applyKnowledgeEvidence(known, "mark_unknown", { now }).state;
  assert.ok(Math.abs(knowledgeView(corrected).pKnown - 0.08) < 0.001);
  assert.equal(knowledgeView(corrected).explicitEvidenceCount, 2);
});

test("diminishes repeated weak evidence and decays belief toward its prior", () => {
  const initial = initialKnowledgeState({ prior: 0.4, now });
  const first = applyKnowledgeEvidence(initial, "context_use", { sameKindCount: 0, now });
  const third = applyKnowledgeEvidence(first.state, "context_use", { sameKindCount: 2, now });
  assert.ok(Math.abs(third.delta) < Math.abs(first.delta));

  const later = decayedKnowledgeState(third.state, {
    now: "2027-08-24T00:00:00.000Z",
    halfLifeMs: 365 * 24 * 60 * 60 * 1_000
  });
  assert.ok(Math.abs(later.logOdds - later.priorLogOdds) < Math.abs(third.state.logOdds - third.state.priorLogOdds));
});

test("explanation policy prioritizes explicitly unknown concepts without hiding new concepts", () => {
  const initial = initialKnowledgeState({ now });
  assert.equal(shouldExplainConcept(initial, { now }), true);
  const known = applyKnowledgeEvidence(initial, "mark_known", { now }).state;
  const unknown = applyKnowledgeEvidence(initial, "mark_unknown", { now }).state;
  assert.ok(explanationScore(unknown, { now }) > explanationScore(initial, { now }));
  assert.equal(shouldExplainConcept(known, { now }), false);
});

test("rejects unknown evidence kinds instead of silently mutating state", () => {
  assert.throws(() => applyKnowledgeEvidence(initialKnowledgeState({ now }), "silence", { now }), /지원하지 않는/);
});
