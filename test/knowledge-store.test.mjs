import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeSqliteDatabases } from "../lib/sqlite-database.mjs";
import { KnowledgeStore } from "../lib/knowledge-store.mjs";

test("persists private knowledge evidence idempotently and isolates users", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-store-"));
  context.after(() => closeSqliteDatabases());
  const store = new KnowledgeStore(path.join(root, "knowledge.sqlite"));
  const first = await store.recordEvidence({
    userId: "user-a", conceptLabel: "임베딩", kind: "mark_known", eventId: "event-1", organizationId: "org-a"
  });
  assert.equal(first.duplicate, false);
  assert.ok(first.state.pKnown > 0.9);

  const duplicate = await store.recordEvidence({
    userId: "user-a", conceptLabel: "임베딩", kind: "mark_known", eventId: "event-1", organizationId: "org-a"
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.state.evidenceCount, 1);
  assert.equal((await store.list("user-b")).length, 0);
  assert.equal((await store.list("user-a")).length, 1);
});

test("returns explicit onboarding priors without writing evidence and supports owner reset", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-prior-"));
  context.after(() => closeSqliteDatabases());
  const store = new KnowledgeStore(path.join(root, "knowledge.sqlite"));
  const states = await store.statesForTerms("user-a", ["VAD", "임베딩", "vad"], ["VAD"]);
  assert.equal(states.length, 2);
  assert.equal(states.find(({ term }) => term === "VAD").source, "explicit_prior");
  assert.ok(states.find(({ term }) => term === "VAD").pKnown > 0.89);
  assert.equal(await store.remove("user-b", states[0].conceptId), false);

  await store.recordEvidence({ userId: "user-a", conceptLabel: "VAD", kind: "mark_unknown", eventId: "event-2", prior: 0.9 });
  assert.equal(await store.remove("user-a", states[0].conceptId), true);
  assert.equal((await store.list("user-a")).length, 0);
});

test("dampens repeated weak observations using persisted same-kind counts", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-repeat-"));
  context.after(() => closeSqliteDatabases());
  const store = new KnowledgeStore(path.join(root, "knowledge.sqlite"));
  const first = await store.recordEvidence({ userId: "user-a", conceptLabel: "RAG", kind: "card_open", eventId: "open-1" });
  const second = await store.recordEvidence({ userId: "user-a", conceptLabel: "RAG", kind: "card_open", eventId: "open-2" });
  assert.equal(second.state.evidenceCount, 2);
  assert.ok(first.state.pKnown - second.state.pKnown < 0.03);
});

test("caches generated explanations privately and removes them with the concept", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-explanation-store-"));
  context.after(() => closeSqliteDatabases());
  const store = new KnowledgeStore(path.join(root, "knowledge.sqlite"));
  const cacheKey = "a".repeat(64);
  await store.recordEvidence({ userId: "user-a", conceptLabel: "임베딩", kind: "card_open", eventId: "open-cache" });
  const saved = await store.saveExplanation({
    userId: "user-a", cacheKey, conceptLabel: "임베딩", level: "simple",
    result: {
      explanation: "쉬운 설명", correctChoiceIndex: 1,
      originalSentence: "이번 회의에서 임베딩을 도입하기로 했다.",
      rewrittenContext: "이번 회의에서 의미를 숫자로 바꾼 값을 도입하기로 했다."
    },
    source: "openai", model: "test-model", meetingId: "meeting-a", segmentIndex: 2
  });
  assert.equal(saved.result.correctChoiceIndex, 1);
  assert.equal(saved.result.originalSentence, "이번 회의에서 임베딩을 도입하기로 했다.");
  assert.equal(saved.result.rewrittenContext, "이번 회의에서 의미를 숫자로 바꾼 값을 도입하기로 했다.");
  assert.equal(saved.segmentIndex, 2);
  assert.equal(await store.getExplanation("user-b", cacheKey), null);
  assert.equal((await store.getExplanation("user-a", cacheKey)).term, "임베딩");
  assert.equal(await store.claimExplanationAnswer("user-a", cacheKey, 1), true);
  assert.equal(await store.claimExplanationAnswer("user-a", cacheKey, 0), false);
  assert.equal((await store.getExplanation("user-a", cacheKey)).answeredChoiceIndex, 1);
  assert.equal(await store.remove("user-a", saved.conceptId), true);
  assert.equal(await store.getExplanation("user-a", cacheKey), null);
});
