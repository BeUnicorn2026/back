import { randomUUID } from "node:crypto";
import {
  applyKnowledgeEvidence, conceptIdFor, initialKnowledgeState, knowledgeTwinDefaults,
  knowledgeView, KNOWLEDGE_EVIDENCE_RULES, normalizeConceptLabel
} from "./knowledge-twin.mjs";
import { openSqliteDatabase, runTransaction } from "./sqlite-database.mjs";

function clean(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function stateFromRow(row) {
  return {
    logOdds: Number(row.log_odds),
    priorLogOdds: Number(row.prior_log_odds),
    evidenceCount: Number(row.evidence_count),
    evidenceWeight: Number(row.evidence_weight),
    explicitEvidenceCount: Number(row.explicit_evidence_count),
    lastUpdatedAt: row.last_updated_at
  };
}

function publicState(row, now = new Date().toISOString()) {
  const view = knowledgeView(stateFromRow(row), { now });
  return {
    conceptId: row.concept_id,
    term: row.concept_label,
    pKnown: view.pKnown,
    confidence: view.confidence,
    status: view.status,
    evidenceCount: view.evidenceCount,
    explicitEvidenceCount: view.explicitEvidenceCount,
    lastUpdatedAt: row.last_updated_at,
    source: "evidence"
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
    cacheKey: row.cache_key,
    conceptId: row.concept_id,
    term: row.concept_label,
    level: row.level,
    result: JSON.parse(row.result_json),
    source: row.source,
    model: row.model || null,
    meetingId: row.meeting_id || null,
    segmentIndex: row.segment_index == null ? null : Number(row.segment_index),
    answeredChoiceIndex: row.answered_choice_index == null ? null : Number(row.answered_choice_index),
    answeredAt: row.answered_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class KnowledgeStore {
  constructor(databasePath) {
    this.databasePath = databasePath;
    this.database = null;
    this.initializing = null;
  }

  async initialize() {
    if (!this.initializing) this.initializing = this.#initialize();
    return this.initializing;
  }

  async #initialize() {
    this.database = await openSqliteDatabase(this.databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS user_concept_states (
        user_id TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        concept_label TEXT NOT NULL,
        log_odds REAL NOT NULL,
        prior_log_odds REAL NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 0,
        evidence_weight REAL NOT NULL DEFAULT 0,
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
        answered_choice_index INTEGER,
        answered_at TEXT,
        event_id TEXT NOT NULL,
        delta REAL NOT NULL,
        previous_log_odds REAL NOT NULL,
        next_log_odds REAL NOT NULL,
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
    const explanationColumns = new Set(this.database.prepare("PRAGMA table_info(knowledge_explanations)").all()
      .map(({ name }) => name));
    if (!explanationColumns.has("answered_choice_index")) {
      this.database.exec("ALTER TABLE knowledge_explanations ADD COLUMN answered_choice_index INTEGER");
    }
    if (!explanationColumns.has("answered_at")) {
      this.database.exec("ALTER TABLE knowledge_explanations ADD COLUMN answered_at TEXT");
    }
  }

  async #ready() {
    await this.initialize();
    return this.database;
  }

  async list(userId, { limit = 500 } = {}) {
    const database = await this.#ready();
    const safeLimit = Math.max(1, Math.min(1_000, Number(limit) || 500));
    return database.prepare(`SELECT * FROM user_concept_states
      WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`).all(userId, safeLimit).map((row) => publicState(row));
  }

  async statesForTerms(userId, terms, knownTerms = []) {
    const database = await this.#ready();
    const unique = new Map();
    for (const term of (Array.isArray(terms) ? terms : []).map(normalizeConceptLabel).filter(Boolean)) {
      if (!unique.has(conceptIdFor(term))) unique.set(conceptIdFor(term), term);
    }
    const normalized = [...unique.entries()];
    if (!normalized.length) return [];
    const ids = normalized.map(([id]) => id);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = database.prepare(`SELECT * FROM user_concept_states
      WHERE user_id = ? AND concept_id IN (${placeholders})`).all(userId, ...ids);
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
    const database = await this.#ready();
    const term = normalizeConceptLabel(conceptLabel);
    const conceptId = conceptIdFor(term);
    const safeEventId = clean(eventId, 120);
    if (!userId || !term || !conceptId) throw new Error("지식 증거에는 사용자와 용어가 필요합니다.");
    if (!KNOWLEDGE_EVIDENCE_RULES[kind]) throw new Error("지원하지 않는 지식 증거입니다.");
    if (!safeEventId) throw new Error("지식 증거 eventId가 필요합니다.");
    return runTransaction(database, () => {
      const duplicate = database.prepare("SELECT id FROM concept_evidence WHERE user_id = ? AND event_id = ?").get(userId, safeEventId);
      if (duplicate) {
        const row = database.prepare("SELECT * FROM user_concept_states WHERE user_id = ? AND concept_id = ?").get(userId, conceptId);
        return { state: publicState(row), duplicate: true };
      }
      const now = new Date().toISOString();
      let row = database.prepare("SELECT * FROM user_concept_states WHERE user_id = ? AND concept_id = ?").get(userId, conceptId);
      const current = row ? stateFromRow(row) : initialKnowledgeState({ prior, now });
      const sameKindCount = Number(database.prepare(`SELECT COUNT(*) AS count FROM concept_evidence
        WHERE user_id = ? AND concept_id = ? AND kind = ?`).get(userId, conceptId, kind).count);
      const applied = applyKnowledgeEvidence(current, kind, { sameKindCount, now });
      database.prepare(`INSERT INTO user_concept_states
        (user_id, concept_id, concept_label, log_odds, prior_log_odds, evidence_count, evidence_weight,
         explicit_evidence_count, last_updated_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, concept_id) DO UPDATE SET concept_label = excluded.concept_label,
          log_odds = excluded.log_odds, prior_log_odds = excluded.prior_log_odds,
          evidence_count = excluded.evidence_count, evidence_weight = excluded.evidence_weight,
          explicit_evidence_count = excluded.explicit_evidence_count,
          last_updated_at = excluded.last_updated_at, updated_at = excluded.updated_at`)
        .run(userId, conceptId, term, applied.state.logOdds, applied.state.priorLogOdds,
          applied.state.evidenceCount, applied.state.evidenceWeight, applied.state.explicitEvidenceCount, now, now, now);
      database.prepare(`INSERT INTO concept_evidence
        (id, user_id, concept_id, organization_id, meeting_id, kind, segment_index, event_id,
         delta, previous_log_odds, next_log_odds, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), userId, conceptId, organizationId, meetingId, kind,
          Number.isInteger(segmentIndex) ? segmentIndex : null, safeEventId,
          applied.delta, current.logOdds, applied.state.logOdds, now);
      row = database.prepare("SELECT * FROM user_concept_states WHERE user_id = ? AND concept_id = ?").get(userId, conceptId);
      return { state: publicState(row, now), duplicate: false };
    });
  }

  async getExplanation(userId, cacheKey) {
    const database = await this.#ready();
    return explanationFromRow(database.prepare(`SELECT * FROM knowledge_explanations
      WHERE user_id = ? AND cache_key = ?`).get(userId, clean(cacheKey, 64)));
  }

  async saveExplanation({
    userId, cacheKey, conceptLabel, level, result, source, model = null,
    meetingId = null, segmentIndex = null
  }) {
    const database = await this.#ready();
    const term = normalizeConceptLabel(conceptLabel);
    const conceptId = conceptIdFor(term);
    const safeCacheKey = clean(cacheKey, 64);
    if (!userId || !term || !conceptId || !/^[a-f0-9]{64}$/.test(safeCacheKey)) {
      throw new Error("맞춤 해설 저장 정보가 올바르지 않습니다.");
    }
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO knowledge_explanations
      (user_id, cache_key, concept_id, concept_label, level, result_json, source, model,
       meeting_id, segment_index, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, cache_key) DO UPDATE SET result_json = excluded.result_json,
        source = excluded.source, model = excluded.model, meeting_id = excluded.meeting_id,
        segment_index = excluded.segment_index, updated_at = excluded.updated_at`)
      .run(userId, safeCacheKey, conceptId, term, clean(level, 20), JSON.stringify(result), clean(source, 30),
        model ? clean(model, 80) : null, meetingId, Number.isInteger(segmentIndex) ? segmentIndex : null, now, now);
    return this.getExplanation(userId, safeCacheKey);
  }

  async claimExplanationAnswer(userId, cacheKey, choiceIndex) {
    const database = await this.#ready();
    const safeCacheKey = clean(cacheKey, 64);
    const safeChoice = Number(choiceIndex);
    if (!Number.isInteger(safeChoice) || safeChoice < 0 || safeChoice > 2) return false;
    const now = new Date().toISOString();
    return database.prepare(`UPDATE knowledge_explanations SET answered_choice_index = ?, answered_at = ?, updated_at = ?
      WHERE user_id = ? AND cache_key = ? AND answered_choice_index IS NULL`)
      .run(safeChoice, now, now, userId, safeCacheKey).changes === 1;
  }

  async remove(userId, conceptId) {
    const database = await this.#ready();
    return runTransaction(database, () => {
      database.prepare("DELETE FROM knowledge_explanations WHERE user_id = ? AND concept_id = ?").run(userId, conceptId);
      return database.prepare("DELETE FROM user_concept_states WHERE user_id = ? AND concept_id = ?").run(userId, conceptId).changes > 0;
    });
  }
}
