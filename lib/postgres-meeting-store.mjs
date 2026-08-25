import { randomUUID } from "node:crypto";
import { aggregateVocabularyTerms } from "./vocabulary-terms.mjs";

const allowedStatuses = new Set(["recording", "completed", "interrupted"]);
const allowedSources = new Set(["live", "upload"]);
const allowedModes = new Set(["stt", "speaker"]);

function cleanText(value, maximum = 10_000) {
  return String(value || "").trim().slice(0, maximum);
}

function cleanSegments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5_000).map((segment, index) => {
    const start = Math.max(0, Number(segment?.start) || 0);
    const end = Math.max(start, Number(segment?.end) || start);
    return {
      id: cleanText(segment?.id, 120) || `segment-${index}-${start}`,
      speaker: cleanText(segment?.speaker, 80) || "미등록 화자",
      known: Boolean(segment?.known),
      corrected: Boolean(segment?.corrected),
      transcriptCorrected: Boolean(segment?.transcriptCorrected),
      confidence: segment?.confidence == null
        ? null
        : Number.isFinite(Number(segment.confidence)) ? Number(segment.confidence) : null,
      transcriptConfidence: segment?.transcriptConfidence == null
        ? null
        : Number.isFinite(Number(segment.transcriptConfidence)) ? Number(segment.transcriptConfidence) : null,
      sourceSpeaker: segment?.sourceSpeaker == null ? null : cleanText(segment.sourceSpeaker, 40),
      start,
      end,
      text: cleanText(segment?.text)
    };
  }).filter(({ text }) => text);
}

function deriveTitle(segments, fallback) {
  const first = segments.find(({ text }) => text)?.text || "";
  if (!first) return fallback;
  const compact = first.replace(/\s+/g, " ");
  return compact.length > 34 ? `${compact.slice(0, 34)}…` : compact;
}

function segmentFromRow(row) {
  return {
    id: row.id,
    speaker: row.speaker,
    known: Boolean(row.known),
    corrected: Boolean(row.corrected),
    transcriptCorrected: Boolean(row.transcript_corrected),
    confidence: row.confidence == null ? null : Number(row.confidence),
    transcriptConfidence: row.transcript_confidence == null ? null : Number(row.transcript_confidence),
    sourceSpeaker: row.source_speaker,
    start: Number(row.start),
    end: Number(row.end),
    text: row.text
  };
}

function meetingFromRow(row, segments) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    createdBy: row.created_by,
    title: row.title,
    language: row.language,
    source: row.source,
    mode: row.mode,
    status: row.status,
    segments,
    duration: Number(row.duration),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at
  };
}

function summarize(meeting) {
  const speakers = [...new Set(meeting.segments.map(({ speaker }) => speaker))];
  return { ...meeting, speakerCount: speakers.length, segmentCount: meeting.segments.length, speakers };
}

export class PostgresMeetingStore {
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
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        title TEXT NOT NULL,
        language TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('live', 'upload')),
        mode TEXT NOT NULL CHECK(mode IN ('stt', 'speaker')),
        status TEXT NOT NULL CHECK(status IN ('recording', 'completed', 'interrupted')),
        duration DOUBLE PRECISION NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        updated_at TEXT NOT NULL,
        import_key TEXT
      );
      CREATE TABLE IF NOT EXISTS meeting_segments (
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        id TEXT NOT NULL,
        speaker TEXT NOT NULL,
        known BOOLEAN NOT NULL,
        corrected BOOLEAN NOT NULL DEFAULT FALSE,
        transcript_corrected BOOLEAN NOT NULL DEFAULT FALSE,
        confidence DOUBLE PRECISION,
        transcript_confidence DOUBLE PRECISION,
        source_speaker TEXT,
        start DOUBLE PRECISION NOT NULL,
        "end" DOUBLE PRECISION NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (meeting_id, position)
      );
      CREATE TABLE IF NOT EXISTS meeting_intelligence (
        meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL,
        transcript_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        model TEXT,
        result_json JSONB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meetings_organization_started_idx ON meetings(organization_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS meeting_segments_meeting_idx ON meeting_segments(meeting_id, position);
      CREATE INDEX IF NOT EXISTS meeting_intelligence_organization_idx ON meeting_intelligence(organization_id);
      ALTER TABLE meeting_segments ADD COLUMN IF NOT EXISTS corrected BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE meeting_segments ADD COLUMN IF NOT EXISTS transcript_corrected BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE meeting_segments ADD COLUMN IF NOT EXISTS transcript_confidence DOUBLE PRECISION;
      ALTER TABLE meetings ADD COLUMN IF NOT EXISTS import_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS meetings_organization_import_idx
        ON meetings(organization_id, import_key) WHERE import_key IS NOT NULL;
    `);
  }

  async #segmentsFor(queryable, meetingId) {
    const rows = (await queryable.query(
      'SELECT * FROM meeting_segments WHERE meeting_id = $1 ORDER BY position ASC', [meetingId]
    )).rows;
    return rows.map(segmentFromRow);
  }

  async #meetingFromId(queryable, id, organizationId) {
    const row = (await queryable.query(
      "SELECT * FROM meetings WHERE id = $1 AND organization_id = $2", [id, organizationId]
    )).rows[0];
    return row ? meetingFromRow(row, await this.#segmentsFor(queryable, row.id)) : null;
  }

  async #replaceSegments(queryable, meetingId, segments) {
    await queryable.query("DELETE FROM meeting_segments WHERE meeting_id = $1", [meetingId]);
    for (const [position, segment] of segments.entries()) {
      await queryable.query(`INSERT INTO meeting_segments
        (meeting_id, position, id, speaker, known, corrected, transcript_corrected, confidence, transcript_confidence, source_speaker, start, "end", text)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [meetingId, position, segment.id, segment.speaker, segment.known, segment.corrected,
        segment.transcriptCorrected, segment.confidence, segment.transcriptConfidence,
        segment.sourceSpeaker, segment.start, segment.end, segment.text]);
    }
  }

  async list(organizationId) {
    await this.initialize();
    const rows = (await this.database.query(
      "SELECT * FROM meetings WHERE organization_id = $1 ORDER BY started_at DESC", [organizationId]
    )).rows;
    return Promise.all(rows.map(async (row) => summarize(meetingFromRow(row, await this.#segmentsFor(this.database, row.id)))));
  }

  async get(id, organizationId) {
    await this.initialize();
    const meeting = await this.#meetingFromId(this.database, id, organizationId);
    return meeting ? summarize(meeting) : null;
  }

  async create({ organizationId, createdBy, language = "ko", source = "live", mode = "speaker", title = "" }) {
    if (!organizationId || !createdBy) throw new Error("회의 소유 정보가 필요합니다.");
    await this.initialize();
    return this.database.transaction(async (client) => {
      const now = new Date().toISOString();
      const id = randomUUID();
      await client.query(`INSERT INTO meetings
        (id, organization_id, created_by, title, language, source, mode, status, duration, started_at, ended_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'recording', 0, $8, NULL, $8)`,
      [id, organizationId, createdBy, cleanText(title, 120) || "새 회의", cleanText(language, 12) || "ko",
        allowedSources.has(source) ? source : "live", allowedModes.has(mode) ? mode : "speaker", now]);
      return summarize(await this.#meetingFromId(client, id, organizationId));
    });
  }

  async createCompleted({ organizationId, createdBy, language = "ko", source = "upload", mode = "speaker", title = "", segments = [], duration = 0, importKey = null }) {
    if (!organizationId || !createdBy) throw new Error("회의 소유 정보가 필요합니다.");
    await this.initialize();
    return this.database.transaction(async (client) => {
      const sanitizedImportKey = cleanText(importKey, 120) || null;
      if (sanitizedImportKey) {
        const existing = (await client.query(
          "SELECT id FROM meetings WHERE organization_id = $1 AND import_key = $2", [organizationId, sanitizedImportKey]
        )).rows[0];
        if (existing) return summarize(await this.#meetingFromId(client, existing.id, organizationId));
      }
      const sanitizedSegments = cleanSegments(segments);
      if (!sanitizedSegments.length) throw new Error("저장할 대화 내용이 필요합니다.");
      const now = new Date().toISOString();
      const id = randomUUID();
      const sanitizedTitle = cleanText(title, 120) || deriveTitle(sanitizedSegments, "업로드한 회의");
      const sanitizedDuration = Math.max(0, Number(duration) || Math.max(...sanitizedSegments.map(({ end }) => end), 0));
      await client.query(`INSERT INTO meetings
        (id, organization_id, created_by, title, language, source, mode, status, duration, started_at, ended_at, updated_at, import_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', $8, $9, $9, $9, $10)`,
      [id, organizationId, createdBy, sanitizedTitle, cleanText(language, 12) || "ko",
        allowedSources.has(source) ? source : "upload", allowedModes.has(mode) ? mode : "speaker",
        sanitizedDuration, now, sanitizedImportKey]);
      await this.#replaceSegments(client, id, sanitizedSegments);
      return summarize(await this.#meetingFromId(client, id, organizationId));
    });
  }

  async getByImportKey(organizationId, importKey) {
    await this.initialize();
    const sanitizedImportKey = cleanText(importKey, 120);
    if (!sanitizedImportKey) return null;
    const row = (await this.database.query(
      "SELECT id FROM meetings WHERE organization_id = $1 AND import_key = $2", [organizationId, sanitizedImportKey]
    )).rows[0];
    const meeting = row ? await this.#meetingFromId(this.database, row.id, organizationId) : null;
    return meeting ? summarize(meeting) : null;
  }

  async update(id, organizationId, changes = {}) {
    await this.initialize();
    return this.database.transaction(async (client) => {
      const current = await this.#meetingFromId(client, id, organizationId);
      if (!current) return null;
      if (current.status !== "recording" && changes.status === "recording") return summarize(current);
      const segments = changes.segments === undefined ? current.segments : cleanSegments(changes.segments);
      const duration = changes.duration === undefined ? current.duration : Math.max(0, Number(changes.duration) || 0);
      const language = changes.language === undefined ? current.language : (cleanText(changes.language, 12) || current.language);
      const status = allowedStatuses.has(changes.status) ? changes.status : current.status;
      const requestedTitle = cleanText(changes.title, 120);
      const title = requestedTitle || deriveTitle(segments, current.title);
      const endedAt = status !== "recording" && !current.endedAt ? new Date().toISOString() : current.endedAt;
      const updatedAt = new Date().toISOString();
      await client.query(`UPDATE meetings SET title = $1, language = $2, status = $3, duration = $4,
        ended_at = $5, updated_at = $6 WHERE id = $7 AND organization_id = $8`,
      [title, language, status, duration, endedAt, updatedAt, id, organizationId]);
      if (changes.segments !== undefined) await this.#replaceSegments(client, id, segments);
      return summarize(await this.#meetingFromId(client, id, organizationId));
    });
  }

  async remove(id, organizationId) {
    await this.initialize();
    const result = await this.database.query(
      "DELETE FROM meetings WHERE id = $1 AND organization_id = $2 RETURNING id",
      [id, organizationId]
    );
    return result.rowCount > 0;
  }

  async getIntelligence(meetingId, organizationId, transcriptHash) {
    await this.initialize();
    const row = (await this.database.query(`SELECT * FROM meeting_intelligence
      WHERE meeting_id = $1 AND organization_id = $2 AND transcript_hash = $3`,
    [meetingId, organizationId, transcriptHash])).rows[0];
    if (!row) return null;
    const result = typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json;
    return {
      ...result,
      source: row.source,
      model: row.model,
      transcriptHash: row.transcript_hash,
      generatedAt: row.updated_at
    };
  }

  async saveIntelligence({ meetingId, organizationId, transcriptHash, source, model, result }) {
    await this.initialize();
    return this.database.transaction(async (client) => {
      if (!await this.#meetingFromId(client, meetingId, organizationId)) return null;
      const now = new Date().toISOString();
      await client.query(`INSERT INTO meeting_intelligence
        (meeting_id, organization_id, transcript_hash, source, model, result_json, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7) ON CONFLICT(meeting_id) DO UPDATE SET
        organization_id = EXCLUDED.organization_id, transcript_hash = EXCLUDED.transcript_hash,
        source = EXCLUDED.source, model = EXCLUDED.model, result_json = EXCLUDED.result_json, updated_at = EXCLUDED.updated_at`,
      [meetingId, organizationId, transcriptHash, source, model || null, JSON.stringify(result), now]);
      const analyzedTitle = cleanText(result?.title, 120);
      if (analyzedTitle) {
        await client.query("UPDATE meetings SET title = $1, updated_at = $2 WHERE id = $3 AND organization_id = $4",
          [analyzedTitle, now, meetingId, organizationId]);
      }
      const row = (await client.query(`SELECT * FROM meeting_intelligence
        WHERE meeting_id = $1 AND organization_id = $2 AND transcript_hash = $3`,
      [meetingId, organizationId, transcriptHash])).rows[0];
      return {
        ...(typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json),
        source: row.source,
        model: row.model,
        transcriptHash: row.transcript_hash,
        generatedAt: row.updated_at
      };
    });
  }

  async listVocabularyTerms(organizationId, knownTerms = []) {
    await this.initialize();
    const rows = (await this.database.query(`SELECT meeting_id, result_json, updated_at FROM meeting_intelligence
      WHERE organization_id = $1 ORDER BY updated_at DESC`, [organizationId])).rows;
    return aggregateVocabularyTerms(rows.map((row) => ({
      meetingId: row.meeting_id,
      result: typeof row.result_json === "string" ? JSON.parse(row.result_json) : row.result_json,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
    })), knownTerms);
  }
}
