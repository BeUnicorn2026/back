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
