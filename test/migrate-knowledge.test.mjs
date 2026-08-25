import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { newDb } from "pg-mem";
import { closeSqliteDatabases } from "../lib/sqlite-database.mjs";
import { KnowledgeStore } from "../lib/knowledge-store.mjs";
import { PostgresDatabase } from "../lib/postgres-database.mjs";
import { PostgresKnowledgeStore } from "../lib/postgres-knowledge-store.mjs";
import { insertKnowledgeRows, KNOWLEDGE_TABLES } from "../lib/knowledge-migration.mjs";

async function withDatabase(run) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const database = new PostgresDatabase({ pool });
  try {
    await run(database);
  } finally {
    await pool.end();
  }
}

test("migrates knowledge tables into PostgreSQL idempotently without touching SQLite", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migrate-knowledge-"));
  const sqlitePath = path.join(root, "knowledge.sqlite");
  context.after(() => closeSqliteDatabases());

  const store = new KnowledgeStore(sqlitePath);
  await store.recordEvidence({ userId: "user-a", conceptLabel: "임베딩", kind: "card_open", eventId: "open-1", meetingId: "meeting-a", segmentIndex: 1 });
  await store.recordEvidence({ userId: "user-a", conceptLabel: "VAD", kind: "mark_known", eventId: "known-1" });
  const cacheKey = "a".repeat(64);
  await store.saveExplanation({
    userId: "user-a", cacheKey, conceptLabel: "임베딩", level: "simple",
    result: {
      explanation: "쉬운 설명", correctChoiceIndex: 1,
      originalSentence: "이번 회의에서 임베딩을 도입하기로 했다.",
      rewrittenContext: "이번 회의에서 의미를 숫자로 바꾼 값을 도입하기로 했다."
    },
    source: "openai", model: "test-model", meetingId: "meeting-a", segmentIndex: 1
  });
  await store.claimExplanationAnswer("user-a", cacheKey, 1);

  const reader = new DatabaseSync(sqlitePath, { readOnly: true });
  const snapshot = Object.fromEntries(KNOWLEDGE_TABLES.map((table) => [table, reader.prepare(`SELECT * FROM ${table}`).all()]));
  const sourceCounts = Object.fromEntries(KNOWLEDGE_TABLES.map((table) => [table, snapshot[table].length]));
  assert.equal(sourceCounts.user_concept_states, 2);
  assert.equal(sourceCounts.concept_evidence, 2);
  assert.equal(sourceCounts.knowledge_explanations, 1);

  await withDatabase(async (database) => {
    await new PostgresKnowledgeStore(database).initialize();
    await database.transaction((client) => insertKnowledgeRows(client, snapshot));
    await database.transaction((client) => insertKnowledgeRows(client, snapshot));

    for (const table of KNOWLEDGE_TABLES) {
      const count = Number((await database.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
      assert.equal(count, sourceCounts[table], `${table} count`);
    }
    const explanation = (await database.query("SELECT * FROM knowledge_explanations WHERE user_id = $1 AND cache_key = $2", ["user-a", cacheKey])).rows[0];
    assert.equal(explanation.result_json, snapshot.knowledge_explanations[0].result_json);
    assert.equal(Number(explanation.answered_choice_index), 1);
    assert.equal(JSON.parse(explanation.result_json).originalSentence, "이번 회의에서 임베딩을 도입하기로 했다.");
  });

  const afterCounts = Object.fromEntries(KNOWLEDGE_TABLES.map((table) => [table, reader.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]));
  reader.close();
  assert.deepEqual(afterCounts, sourceCounts);
});
