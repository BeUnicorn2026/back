import "dotenv/config";
import { stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { PostgresAuthStore } from "../lib/postgres-auth-store.mjs";
import { closePostgresDatabases, PostgresDatabase } from "../lib/postgres-database.mjs";
import { PostgresMeetingStore } from "../lib/postgres-meeting-store.mjs";
import { PostgresRoomStore } from "../lib/postgres-room-store.mjs";
import { PostgresRequestRateLimiter } from "../lib/postgres-rate-limiter.mjs";

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const sourceIndex = args.indexOf("--source");
const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDirectory = process.env.VOICE_PARTITION_DATA_DIR
  ? path.resolve(process.env.VOICE_PARTITION_DATA_DIR)
  : path.join(projectDirectory, ".data");
const sourcePath = sourceIndex >= 0
  ? path.resolve(args[sourceIndex + 1] || "")
  : process.env.VOICE_PARTITION_DATABASE_PATH
    ? path.resolve(process.env.VOICE_PARTITION_DATABASE_PATH)
    : path.join(dataDirectory, "voice-partition.sqlite");

if (args.includes("--help") || args.includes("-h")) {
  console.log(`SQLite → PostgreSQL migration

Usage:
  npm run migrate:postgres
  DATABASE_URL=postgresql://... npm run migrate:postgres -- --commit
  DATABASE_URL=postgresql://... npm run migrate:postgres -- --source /path/app.sqlite --commit

The default run only inspects SQLite. --commit requires an empty PostgreSQL target.`);
  process.exit(0);
}

await stat(sourcePath).catch(() => {
  throw new Error(`SQLite 원본을 찾지 못했습니다: ${sourcePath}`);
});

const source = new DatabaseSync(sourcePath, { readOnly: true });
const tableNames = [
  "users", "organizations", "memberships", "sessions", "email_verifications",
  "rooms", "room_memberships", "meetings", "meeting_segments", "meeting_intelligence", "request_rate_limits"
];

function sourceRows(table) {
  const exists = source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return exists ? source.prepare(`SELECT * FROM ${table}`).all() : [];
}

const snapshot = Object.fromEntries(tableNames.map((table) => [table, sourceRows(table)]));
const counts = Object.fromEntries(tableNames.map((table) => [table, snapshot[table].length]));
console.log(JSON.stringify({ mode: commit ? "commit" : "dry-run", source: sourcePath, counts }, null, 2));

if (!commit) {
  source.close();
  console.log("점검만 완료했습니다. 실제 이관은 DATABASE_URL을 설정하고 --commit을 추가하세요.");
  process.exit(0);
}

if (!process.env.DATABASE_URL) throw new Error("--commit에는 DATABASE_URL이 필요합니다.");
const target = new PostgresDatabase({
  connectionString: process.env.DATABASE_URL,
  maximumConnections: process.env.POSTGRES_POOL_MAX
});

try {
  await new PostgresAuthStore(target, {
    verificationSecret: process.env.EMAIL_VERIFICATION_SECRET || "migration-schema-initialization-secret"
  }).initialize();
  await new PostgresRoomStore(target).initialize();
  await new PostgresMeetingStore(target).initialize();
  await new PostgresRequestRateLimiter(target).initialize();

  const targetCounts = {};
  for (const table of tableNames) {
    targetCounts[table] = Number((await target.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
  }
  const populated = Object.entries(targetCounts).filter(([, count]) => count > 0);
  if (populated.length) {
    throw new Error(`PostgreSQL 대상이 비어 있지 않습니다: ${populated.map(([name, count]) => `${name}=${count}`).join(", ")}`);
  }

  await target.transaction(async (client) => {
    for (const row of snapshot.users) {
      await client.query(`INSERT INTO users
        (id, name, email, password_hash, introduction, active_organization_id, roles_json, known_terms_json,
          onboarded_at, email_verified_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)`,
      [row.id, row.name, row.email, row.password_hash, row.introduction ?? null, row.active_organization_id,
        row.roles_json || "[]", row.known_terms_json || "[]", row.onboarded_at,
        row.email_verified_at, row.created_at, row.updated_at]);
    }
    for (const row of snapshot.organizations) {
      await client.query(`INSERT INTO organizations(id, name, domain, invite_code, created_by, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.name, row.domain, row.invite_code, row.created_by, row.created_at]);
    }
    for (const row of snapshot.memberships) {
      await client.query("INSERT INTO memberships(user_id, organization_id, role, joined_at) VALUES ($1, $2, $3, $4)",
        [row.user_id, row.organization_id, row.role, row.joined_at]);
    }
    for (const row of snapshot.sessions) {
      await client.query("INSERT INTO sessions(id, user_id, token_hash, csrf_token, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [row.id, row.user_id, row.token_hash, row.csrf_token, row.expires_at, row.created_at]);
    }
    for (const row of snapshot.email_verifications) {
      await client.query(`INSERT INTO email_verifications
        (user_id, code_hash, expires_at, attempt_count, last_sent_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.user_id, row.code_hash, row.expires_at, row.attempt_count, row.last_sent_at, row.created_at]);
    }
    for (const row of snapshot.rooms) {
      await client.query(`INSERT INTO rooms
        (id, room, access_code, organization_id, created_by, status, idempotency_key,
          created_at, updated_at, closed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [row.id, row.room, row.access_code, row.organization_id, row.created_by, row.status,
        row.idempotency_key, row.created_at, row.updated_at, row.closed_at]);
    }
    for (const row of snapshot.room_memberships) {
      await client.query(`INSERT INTO room_memberships
        (room_id, organization_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4, $5)`,
      [row.room_id, row.organization_id, row.user_id, row.role, row.joined_at]);
    }
    for (const row of snapshot.meetings) {
      await client.query(`INSERT INTO meetings
        (id, organization_id, created_by, room_id, title, language, source, mode, status,
          duration, started_at, ended_at, updated_at, import_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [row.id, row.organization_id, row.created_by, row.room_id ?? null, row.title, row.language,
        row.source, row.mode, row.status, row.duration, row.started_at, row.ended_at,
        row.updated_at, row.import_key ?? null]);
    }
    for (const row of snapshot.meeting_segments) {
      await client.query(`INSERT INTO meeting_segments
        (meeting_id, position, id, speaker, known, corrected, transcript_corrected, confidence,
          transcript_confidence, source_speaker, user_id, speaker_profile_id, sequence, start, "end", text)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [row.meeting_id, row.position, row.id, row.speaker, Boolean(row.known), Boolean(row.corrected),
        Boolean(row.transcript_corrected), row.confidence, row.transcript_confidence ?? null,
        row.source_speaker, row.user_id ?? null, row.speaker_profile_id ?? null,
        row.sequence ?? row.position, row.start, row.end, row.text]);
    }
    for (const row of snapshot.meeting_intelligence) {
      await client.query(`INSERT INTO meeting_intelligence
        (meeting_id, organization_id, transcript_hash, source, model, result_json, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [row.meeting_id, row.organization_id, row.transcript_hash, row.source, row.model,
        row.result_json, row.created_at, row.updated_at]);
    }
    for (const row of snapshot.request_rate_limits) {
      await client.query("INSERT INTO request_rate_limits(key_hash, window_started_at, request_count) VALUES ($1, $2, $3)",
        [row.key_hash, row.window_started_at, row.request_count]);
    }
  });

  const verifiedCounts = {};
  for (const table of tableNames) {
    verifiedCounts[table] = Number((await target.query(`SELECT COUNT(*) AS count FROM ${table}`)).rows[0].count);
    if (verifiedCounts[table] !== counts[table]) {
      throw new Error(`${table} 검증 실패: source=${counts[table]}, target=${verifiedCounts[table]}`);
    }
  }
  console.log(JSON.stringify({ migrated: true, verifiedCounts }, null, 2));
} finally {
  source.close();
  await closePostgresDatabases();
}
