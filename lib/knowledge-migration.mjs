// Row-for-row copy of the per-user knowledge tables from a SQLite snapshot into
// PostgreSQL. Kept in its own module (not the CLI migration script) so it can be
// unit-tested without triggering the script's top-level argv/stat side effects.
// Every insert is idempotent via a targetless ON CONFLICT DO NOTHING, so re-running
// the migration never duplicates or errors on already-copied rows.

export const KNOWLEDGE_TABLES = ["user_concept_states", "concept_evidence", "knowledge_explanations"];

export async function insertKnowledgeRows(client, snapshot) {
  for (const row of snapshot.user_concept_states || []) {
    await client.query(`INSERT INTO user_concept_states
      (user_id, concept_id, concept_label, log_odds, prior_log_odds, evidence_count, evidence_weight,
       explicit_evidence_count, last_updated_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT DO NOTHING`,
    [row.user_id, row.concept_id, row.concept_label, Number(row.log_odds), Number(row.prior_log_odds),
      Number(row.evidence_count), Number(row.evidence_weight), Number(row.explicit_evidence_count),
      row.last_updated_at, row.created_at, row.updated_at]);
  }
  for (const row of snapshot.concept_evidence || []) {
    await client.query(`INSERT INTO concept_evidence
      (id, user_id, concept_id, organization_id, meeting_id, kind, segment_index,
       answered_choice_index, answered_at, event_id, delta, previous_log_odds, next_log_odds, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT DO NOTHING`,
    [row.id, row.user_id, row.concept_id, row.organization_id ?? null, row.meeting_id ?? null, row.kind,
      row.segment_index ?? null, row.answered_choice_index ?? null, row.answered_at ?? null, row.event_id,
      Number(row.delta), Number(row.previous_log_odds), Number(row.next_log_odds), row.created_at]);
  }
  for (const row of snapshot.knowledge_explanations || []) {
    await client.query(`INSERT INTO knowledge_explanations
      (user_id, cache_key, concept_id, concept_label, level, result_json, source, model,
       meeting_id, segment_index, answered_choice_index, answered_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT DO NOTHING`,
    [row.user_id, row.cache_key, row.concept_id, row.concept_label, row.level, row.result_json,
      row.source, row.model ?? null, row.meeting_id ?? null, row.segment_index ?? null,
      row.answered_choice_index ?? null, row.answered_at ?? null, row.created_at, row.updated_at]);
  }
}
