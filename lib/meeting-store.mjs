import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { openSqliteDatabase, runTransaction } from "./sqlite-database.mjs";
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

export class MeetingStore {
  constructor(rootDirectory, options = {}) {
    this.rootDirectory = rootDirectory;
    this.statePath = path.join(rootDirectory, "meetings.json");
    this.databasePath = options.databasePath || path.join(rootDirectory, "meetings.sqlite");
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
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        title TEXT NOT NULL,
        language TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('live', 'upload')),
        mode TEXT NOT NULL CHECK(mode IN ('stt', 'speaker')),
        status TEXT NOT NULL CHECK(status IN ('recording', 'completed', 'interrupted')),
        duration REAL NOT NULL DEFAULT 0,
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
        known INTEGER NOT NULL,
        corrected INTEGER NOT NULL DEFAULT 0,
        transcript_corrected INTEGER NOT NULL DEFAULT 0,
        confidence REAL,
        transcript_confidence REAL,
        source_speaker TEXT,
        start REAL NOT NULL,
        end REAL NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (meeting_id, position)
      );
      CREATE TABLE IF NOT EXISTS meeting_intelligence (
        meeting_id TEXT PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL,
        transcript_hash TEXT NOT NULL,
        source TEXT NOT NULL,
        model TEXT,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meetings_organization_started_idx ON meetings(organization_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS meeting_segments_meeting_idx ON meeting_segments(meeting_id, position);
      CREATE INDEX IF NOT EXISTS meeting_intelligence_organization_idx ON meeting_intelligence(organization_id);
    `);
    const segmentColumns = this.database.prepare("PRAGMA table_info(meeting_segments)").all();
    if (!segmentColumns.some(({ name }) => name === "corrected")) {
      this.database.exec("ALTER TABLE meeting_segments ADD COLUMN corrected INTEGER NOT NULL DEFAULT 0");
    }
    if (!segmentColumns.some(({ name }) => name === "transcript_corrected")) {
      this.database.exec("ALTER TABLE meeting_segments ADD COLUMN transcript_corrected INTEGER NOT NULL DEFAULT 0");
    }
    if (!segmentColumns.some(({ name }) => name === "transcript_confidence")) {
      this.database.exec("ALTER TABLE meeting_segments ADD COLUMN transcript_confidence REAL");
    }
    const meetingColumns = this.database.prepare("PRAGMA table_info(meetings)").all();
    if (!meetingColumns.some(({ name }) => name === "import_key")) {
      this.database.exec("ALTER TABLE meetings ADD COLUMN import_key TEXT");
    }
    this.database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS meetings_organization_import_idx
      ON meetings(organization_id, import_key) WHERE import_key IS NOT NULL`);
    await this.#importLegacyJson();
  }

  async #importLegacyJson() {
    if (this.database.prepare("SELECT 1 FROM legacy_imports WHERE source = ?").get("meetings-json-v1")) return;
    let legacy;
    try {
      legacy = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`기존 회의 데이터를 읽지 못했습니다: ${error.message}`, { cause: error });
    }
    runTransaction(this.database, () => {
      let imported = 0;
      for (const meeting of legacy?.meetings || []) {
        const result = this.database.prepare(`INSERT OR IGNORE INTO meetings
          (id, organization_id, created_by, title, language, source, mode, status, duration, started_at, ended_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(meeting.id, meeting.organizationId, meeting.createdBy, cleanText(meeting.title, 120) || "새 회의",
            cleanText(meeting.language, 12) || "ko", allowedSources.has(meeting.source) ? meeting.source : "live",
            allowedModes.has(meeting.mode) ? meeting.mode : "speaker", allowedStatuses.has(meeting.status) ? meeting.status : "completed",
            Math.max(0, Number(meeting.duration) || 0), meeting.startedAt, meeting.endedAt || null, meeting.updatedAt || meeting.startedAt);
        if (result.changes) {
          this.#replaceSegments(meeting.id, cleanSegments(meeting.segments));
          imported += 1;
        }
      }
      this.database.prepare("INSERT INTO legacy_imports(source, imported_at, record_count) VALUES (?, ?, ?)")
        .run("meetings-json-v1", new Date().toISOString(), imported);
    });
  }

  async #ready() {
    await this.initialize();
    return this.database;
  }

  #segmentsFor(meetingId) {
    return this.database.prepare("SELECT * FROM meeting_segments WHERE meeting_id = ? ORDER BY position ASC").all(meetingId)
      .map((row) => ({
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
      }));
  }

  #meetingFromId(id, organizationId) {
    const row = this.database.prepare("SELECT * FROM meetings WHERE id = ? AND organization_id = ?").get(id, organizationId);
    return row ? meetingFromRow(row, this.#segmentsFor(row.id)) : null;
  }

  #replaceSegments(meetingId, segments) {
    this.database.prepare("DELETE FROM meeting_segments WHERE meeting_id = ?").run(meetingId);
    const insert = this.database.prepare(`INSERT INTO meeting_segments
      (meeting_id, position, id, speaker, known, corrected, transcript_corrected, confidence, transcript_confidence, source_speaker, start, end, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    segments.forEach((segment, position) => insert.run(meetingId, position, segment.id, segment.speaker,
      segment.known ? 1 : 0, segment.corrected ? 1 : 0, segment.transcriptCorrected ? 1 : 0,
      segment.confidence, segment.transcriptConfidence,
      segment.sourceSpeaker, segment.start, segment.end, segment.text));
  }

  async list(organizationId) {
    const database = await this.#ready();
    return database.prepare("SELECT * FROM meetings WHERE organization_id = ? ORDER BY started_at DESC").all(organizationId)
      .map((row) => summarize(meetingFromRow(row, this.#segmentsFor(row.id))));
  }

  async get(id, organizationId) {
    await this.#ready();
    const meeting = this.#meetingFromId(id, organizationId);
    return meeting ? summarize(meeting) : null;
  }

  async create({ organizationId, createdBy, language = "ko", source = "live", mode = "speaker", title = "" }) {
    if (!organizationId || !createdBy) throw new Error("회의 소유 정보가 필요합니다.");
    const database = await this.#ready();
    return runTransaction(database, () => {
      const now = new Date().toISOString();
      const id = randomUUID();
      database.prepare(`INSERT INTO meetings
        (id, organization_id, created_by, title, language, source, mode, status, duration, started_at, ended_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'recording', 0, ?, NULL, ?)`)
        .run(id, organizationId, createdBy, cleanText(title, 120) || "새 회의", cleanText(language, 12) || "ko",
          allowedSources.has(source) ? source : "live", allowedModes.has(mode) ? mode : "speaker", now, now);
      return summarize(this.#meetingFromId(id, organizationId));
    });
  }

  async createCompleted({ organizationId, createdBy, language = "ko", source = "upload", mode = "speaker", title = "", segments = [], duration = 0, importKey = null }) {
    if (!organizationId || !createdBy) throw new Error("회의 소유 정보가 필요합니다.");
    const database = await this.#ready();
    return runTransaction(database, () => {
      const sanitizedImportKey = cleanText(importKey, 120) || null;
      if (sanitizedImportKey) {
        const existing = database.prepare("SELECT id FROM meetings WHERE organization_id = ? AND import_key = ?")
          .get(organizationId, sanitizedImportKey);
        if (existing) return summarize(this.#meetingFromId(existing.id, organizationId));
      }
      const sanitizedSegments = cleanSegments(segments);
      if (!sanitizedSegments.length) throw new Error("저장할 대화 내용이 필요합니다.");
      const now = new Date().toISOString();
      const id = randomUUID();
      const sanitizedTitle = cleanText(title, 120) || deriveTitle(sanitizedSegments, "업로드한 회의");
      const sanitizedDuration = Math.max(0, Number(duration) || Math.max(...sanitizedSegments.map(({ end }) => end), 0));
      database.prepare(`INSERT INTO meetings
        (id, organization_id, created_by, title, language, source, mode, status, duration, started_at, ended_at, updated_at, import_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`)
        .run(id, organizationId, createdBy, sanitizedTitle, cleanText(language, 12) || "ko",
          allowedSources.has(source) ? source : "upload", allowedModes.has(mode) ? mode : "speaker",
          sanitizedDuration, now, now, now, sanitizedImportKey);
      this.#replaceSegments(id, sanitizedSegments);
      return summarize(this.#meetingFromId(id, organizationId));
    });
  }

  async getByImportKey(organizationId, importKey) {
    const database = await this.#ready();
    const sanitizedImportKey = cleanText(importKey, 120);
    if (!sanitizedImportKey) return null;
    const row = database.prepare("SELECT id FROM meetings WHERE organization_id = ? AND import_key = ?")
      .get(organizationId, sanitizedImportKey);
    const meeting = row ? this.#meetingFromId(row.id, organizationId) : null;
    return meeting ? summarize(meeting) : null;
  }

  async update(id, organizationId, changes = {}) {
    const database = await this.#ready();
    return runTransaction(database, () => {
      const current = this.#meetingFromId(id, organizationId);
      if (!current) return null;
      const segments = changes.segments === undefined ? current.segments : cleanSegments(changes.segments);
      const duration = changes.duration === undefined ? current.duration : Math.max(0, Number(changes.duration) || 0);
      const language = changes.language === undefined ? current.language : (cleanText(changes.language, 12) || current.language);
      const status = allowedStatuses.has(changes.status) ? changes.status : current.status;
      const requestedTitle = cleanText(changes.title, 120);
      const title = requestedTitle || deriveTitle(segments, current.title);
      const endedAt = status !== "recording" && !current.endedAt ? new Date().toISOString() : current.endedAt;
      const updatedAt = new Date().toISOString();
      database.prepare(`UPDATE meetings SET title = ?, language = ?, status = ?, duration = ?, ended_at = ?, updated_at = ?
        WHERE id = ? AND organization_id = ?`)
        .run(title, language, status, duration, endedAt, updatedAt, id, organizationId);
      if (changes.segments !== undefined) this.#replaceSegments(id, segments);
      return summarize(this.#meetingFromId(id, organizationId));
    });
  }

  async getIntelligence(meetingId, organizationId, transcriptHash) {
    const database = await this.#ready();
    const row = database.prepare(`SELECT * FROM meeting_intelligence
      WHERE meeting_id = ? AND organization_id = ? AND transcript_hash = ?`).get(meetingId, organizationId, transcriptHash);
    if (!row) return null;
    return {
      ...JSON.parse(row.result_json),
      source: row.source,
      model: row.model,
      transcriptHash: row.transcript_hash,
      generatedAt: row.updated_at
    };
  }

  async saveIntelligence({ meetingId, organizationId, transcriptHash, source, model, result }) {
    const database = await this.#ready();
    return runTransaction(database, () => {
      if (!this.#meetingFromId(meetingId, organizationId)) return null;
      const now = new Date().toISOString();
      database.prepare(`INSERT INTO meeting_intelligence
        (meeting_id, organization_id, transcript_hash, source, model, result_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(meeting_id) DO UPDATE SET
        organization_id = excluded.organization_id, transcript_hash = excluded.transcript_hash,
        source = excluded.source, model = excluded.model, result_json = excluded.result_json, updated_at = excluded.updated_at`)
        .run(meetingId, organizationId, transcriptHash, source, model || null, JSON.stringify(result), now, now);
      return {
        ...result,
        source,
        model: model || null,
        transcriptHash,
        generatedAt: now
      };
    });
  }

  async listVocabularyTerms(organizationId, knownTerms = []) {
    const database = await this.#ready();
    const rows = database.prepare(`SELECT meeting_id, result_json, updated_at FROM meeting_intelligence
      WHERE organization_id = ? ORDER BY updated_at DESC`).all(organizationId);
    return aggregateVocabularyTerms(rows.map((row) => ({
      meetingId: row.meeting_id,
      result: JSON.parse(row.result_json),
      updatedAt: row.updated_at
    })), knownTerms);
  }
}
