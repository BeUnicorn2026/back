import { randomUUID } from "node:crypto";
import {
  applyKnowledgeEvidence, conceptIdFor, initialKnowledgeState, knowledgeTwinDefaults,
  knowledgeView, KNOWLEDGE_EVIDENCE_RULES, normalizeConceptLabel
} from "./knowledge-twin.mjs";

function clean(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function stateFromRow(row) {
  return {
    logOdds: Number(row.log_odds), priorLogOdds: Number(row.prior_log_odds),
    evidenceCount: Number(row.evidence_count), evidenceWeight: Number(row.evidence_weight),
    explicitEvidenceCount: Number(row.explicit_evidence_count), lastUpdatedAt: row.last_updated_at
  };
}

function publicState(row, now = new Date().toISOString()) {
  const view = knowledgeView(stateFromRow(row), { now });
  return {
    conceptId: row.concept_id, term: row.concept_label, pKnown: view.pKnown,
    confidence: view.confidence, status: view.status, evidenceCount: view.evidenceCount,
    explicitEvidenceCount: view.explicitEvidenceCount, lastUpdatedAt: row.last_updated_at, source: "evidence"
  };
}

function virtualState(term, prior, source, now = new Date().toISOString()) {
  const view = knowledgeView(initialKnowledgeState({ prior, now }), { now });
  return {
    conceptId: conceptIdFor(term), term, pKnown: view.pKnown, confidence: view.confidence,
    status: view.status, evidenceCount: 0, explicitEvidenceCount: 0,
    lastUpdatedAt: null, source
  };
}

function explanationFromRow(row) {
  if (!row) return null;
  return {
    cacheKey: row.cache_key, conceptId: row.concept_id, term: row.concept_label, level: row.level,
    result: JSON.parse(row.result_json), source: row.source, model: row.model || null,
    meetingId: row.meeting_id || null,
    segmentIndex: row.segment_index == null ? null : Number(row.segment_index),
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export class PostgresKnowledgeStore {
  constructor(database) {
    this.database = database;
    this.initializing = null;
  }

  async initialize() {
    if (!this.initializing) this.initializing = this.#initialize();
    return this.initializing;
  }

  async #initialize() {
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS user_concept_states (
        user_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        concept_label TEXT NOT NULL,
        log_odds DOUBLE PRECISION NOT NULL,
        prior_log_odds DOUBLE PRECISION NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        evidence_weight DOUBLE PRECISION NOT NULL DEFAULT 0,
        explicit_evidence_count INTEGER NOT NULL DEFAULT 0,
        last_updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, concept_id)
      );
      CREATE TABLE IF NOT EXISTS concept_evidence (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        organization_id TEXT,
        meeting_id TEXT,
        kind TEXT NOT NULL,
        segment_index INTEGER,
        event_id TEXT NOT NULL,
        delta DOUBLE PRECISION NOT NULL,
        previous_log_odds DOUBLE PRECISION NOT NULL,
        next_log_odds DOUBLE PRECISION NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, event_id),
        FOREIGN KEY (user_id, concept_id) REFERENCES user_concept_states(user_id, concept_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS user_concept_states_updated_idx ON user_concept_states(user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS concept_evidence_concept_idx ON concept_evidence(user_id, concept_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_explanations (
        user_id TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        concept_label TEXT NOT NULL,
        level TEXT NOT NULL,
        result_json TEXT NOT NULL,
        source TEXT NOT NULL,
        model TEXT,
        meeting_id TEXT,
        segment_index INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, cache_key)
      );
      CREATE INDEX IF NOT EXISTS knowledge_explanations_concept_idx
        ON knowledge_explanations(user_id, concept_id, updated_at DESC);
    `);
  }

  async list(userId, { limit = 500 } = {}) {
    await this.initialize();
    const safeLimit = Math.max(1, Math.min(1_000, Number(limit) || 500));
    const rows = (await this.database.query(`SELECT * FROM user_concept_states
      WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`, [userId, safeLimit])).rows;
    return rows.map((row) => publicState(row));
  }

  async statesForTerms(userId, terms, knownTerms = []) {
    await this.initialize();
    const unique = new Map();
    for (const term of (Array.isArray(terms) ? terms : []).map(normalizeConceptLabel).filter(Boolean)) {
      if (!unique.has(conceptIdFor(term))) unique.set(conceptIdFor(term), term);
    }
    const normalized = [...unique.entries()];
    if (!normalized.length) return [];
    const ids = normalized.map(([id]) => id);
    const rows = (await this.database.query(`SELECT * FROM user_concept_states
      WHERE user_id = $1 AND concept_id = ANY($2::text[])`, [userId, ids])).rows;
    const stored = new Map(rows.map((row) => [row.concept_id, row]));
    const known = new Set((Array.isArray(knownTerms) ? knownTerms : []).map(normalizeConceptLabel)
      .filter(Boolean).map((term) => term.toLocaleLowerCase("ko-KR")));
    return normalized.map(([id, term]) => stored.has(id)
      ? publicState(stored.get(id))
      : virtualState(term, known.has(term.toLocaleLowerCase("ko-KR")) ? knowledgeTwinDefaults.knownPrior : knowledgeTwinDefaults.prior,
        known.has(term.toLocaleLowerCase("ko-KR")) ? "explicit_prior" : "default_prior"));
  }

  async recordEvidence({
    userId, conceptLabel, kind, eventId, organizationId = null, meetingId = null,
    segmentIndex = null, prior = knowledgeTwinDefaults.prior
  }) {
    await this.initialize();
    const term = normalizeConceptLabel(conceptLabel);
    const conceptId = conceptIdFor(term);
    const safeEventId = clean(eventId, 120);
    if (!userId || !term || !conceptId) throw new Error("지식 증거에는 사용자와 용어가 필요합니다.");
    if (!KNOWLEDGE_EVIDENCE_RULES[kind]) throw new Error("지원하지 않는 지식 증거입니다.");
    if (!safeEventId) throw new Error("지식 증거 eventId가 필요합니다.");
    return this.database.transaction(async (client) => {
      const now = new Date().toISOString();
      const initial = initialKnowledgeState({ prior, now });
      await client.query(`INSERT INTO user_concept_states
        (user_id, concept_id, concept_label, log_odds, prior_log_odds, evidence_count, evidence_weight,
         explicit_evidence_count, last_updated_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4, 0, 0, 0, $5, $5, $5) ON CONFLICT (user_id, concept_id) DO NOTHING`,
      [userId, conceptId, term, initial.logOdds, now]);
      let row = (await client.query(`SELECT * FROM user_concept_states
        WHERE user_id = $1 AND concept_id = $2 FOR UPDATE`, [userId, conceptId])).rows[0];
      const duplicate = (await client.query(
        "SELECT id FROM concept_evidence WHERE user_id = $1 AND event_id = $2", [userId, safeEventId]
      )).rows[0];
      if (duplicate) return { state: publicState(row), duplicate: true };
      const sameKindCount = Number((await client.query(`SELECT COUNT(*) AS count FROM concept_evidence
        WHERE user_id = $1 AND concept_id = $2 AND kind = $3`, [userId, conceptId, kind])).rows[0].count);
      const current = stateFromRow(row);
      const applied = applyKnowledgeEvidence(current, kind, { sameKindCount, now });
      await client.query(`UPDATE user_concept_states SET concept_label = $1, log_odds = $2,
        prior_log_odds = $3, evidence_count = $4, evidence_weight = $5, explicit_evidence_count = $6,
        last_updated_at = $7, updated_at = $7 WHERE user_id = $8 AND concept_id = $9`,
      [term, applied.state.logOdds, applied.state.priorLogOdds, applied.state.evidenceCount,
        applied.state.evidenceWeight, applied.state.explicitEvidenceCount, now, userId, conceptId]);
      await client.query(`INSERT INTO concept_evidence
        (id, user_id, concept_id, organization_id, meeting_id, kind, segment_index, event_id,
         delta, previous_log_odds, next_log_odds, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [randomUUID(), userId, conceptId, organizationId, meetingId, kind,
        Number.isInteger(segmentIndex) ? segmentIndex : null, safeEventId,
        applied.delta, current.logOdds, applied.state.logOdds, now]);
      row = (await client.query("SELECT * FROM user_concept_states WHERE user_id = $1 AND concept_id = $2", [userId, conceptId])).rows[0];
      return { state: publicState(row, now), duplicate: false };
    });
  }

  async getExplanation(userId, cacheKey) {
    await this.initialize();
    const row = (await this.database.query(`SELECT * FROM knowledge_explanations
      WHERE user_id = $1 AND cache_key = $2`, [userId, clean(cacheKey, 64)])).rows[0];
    return explanationFromRow(row);
  }

  async saveExplanation({
    userId, cacheKey, conceptLabel, level, result, source, model = null,
    meetingId = null, segmentIndex = null
  }) {
    await this.initialize();
    const term = normalizeConceptLabel(conceptLabel);
    const conceptId = conceptIdFor(term);
    const safeCacheKey = clean(cacheKey, 64);
    if (!userId || !term || !conceptId || !/^[a-f0-9]{64}$/.test(safeCacheKey)) {
      throw new Error("맞춤 해설 저장 정보가 올바르지 않습니다.");
    }
    const now = new Date().toISOString();
    await this.database.query(`INSERT INTO knowledge_explanations
      (user_id, cache_key, concept_id, concept_label, level, result_json, source, model,
       meeting_id, segment_index, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
      ON CONFLICT (user_id, cache_key) DO UPDATE SET result_json = excluded.result_json,
        source = excluded.source, model = excluded.model, meeting_id = excluded.meeting_id,
        segment_index = excluded.segment_index, updated_at = excluded.updated_at`,
    [userId, safeCacheKey, conceptId, term, clean(level, 20), JSON.stringify(result), clean(source, 30),
      model ? clean(model, 80) : null, meetingId, Number.isInteger(segmentIndex) ? segmentIndex : null, now]);
    return this.getExplanation(userId, safeCacheKey);
  }

  async remove(userId, conceptId) {
    await this.initialize();
    return this.database.transaction(async (client) => {
      await client.query("DELETE FROM knowledge_explanations WHERE user_id = $1 AND concept_id = $2", [userId, conceptId]);
      return (await client.query(
        "DELETE FROM user_concept_states WHERE user_id = $1 AND concept_id = $2", [userId, conceptId]
      )).rowCount > 0;
    });
  }
}
