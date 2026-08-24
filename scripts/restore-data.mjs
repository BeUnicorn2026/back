import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SpeakerStore } from "../lib/speaker-store.mjs";
import { AuthStore } from "../lib/auth-store.mjs";
import { MeetingStore } from "../lib/meeting-store.mjs";
import { closeSqliteDatabases } from "../lib/sqlite-database.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function exists(target) {
  try { await stat(target); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

const sourceDirectory = option("--from");
const targetDirectory = option("--target");
if (!sourceDirectory || !targetDirectory || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: VOICE_BIOMETRIC_KEY=... npm run restore:data -- --from <backup-directory> --target <new-data-directory>");
  process.exit(sourceDirectory && targetDirectory ? 0 : 2);
}

const source = path.resolve(sourceDirectory);
const target = path.resolve(targetDirectory);
if (!(await exists(path.join(source, "manifest.json")))) throw new Error("유효한 백업 manifest.json을 찾지 못했습니다.");
if (await exists(target)) throw new Error(`복구 대상은 존재하지 않는 새 경로여야 합니다: ${target}`);
const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error("지원하지 않는 백업 manifest입니다.");

for (const file of manifest.files) {
  const absolute = path.resolve(source, file.path);
  if (!absolute.startsWith(`${source}${path.sep}`)) throw new Error(`안전하지 않은 백업 경로입니다: ${file.path}`);
  const contents = await readFile(absolute);
  const checksum = createHash("sha256").update(contents).digest("hex");
  if (contents.length !== file.bytes || checksum !== file.sha256) throw new Error(`백업 무결성 검증 실패: ${file.path}`);
}

const temporaryTarget = `${target}.tmp-${randomUUID()}`;
try {
  await mkdir(temporaryTarget, { recursive: true });
  await cp(path.join(source, "voice-partition.sqlite"), path.join(temporaryTarget, "voice-partition.sqlite"));
  if (await exists(path.join(source, "speakers"))) {
    await cp(path.join(source, "speakers"), path.join(temporaryTarget, "speakers"), { recursive: true });
  }
  if (await exists(path.join(source, "legacy"))) {
    await Promise.all([
      mkdir(path.join(temporaryTarget, "auth"), { recursive: true }),
      mkdir(path.join(temporaryTarget, "meetings"), { recursive: true })
    ]);
    await cp(path.join(source, "legacy", "auth.json"), path.join(temporaryTarget, "auth", "auth.json")).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await cp(path.join(source, "legacy", "meetings.json"), path.join(temporaryTarget, "meetings", "meetings.json")).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }

  const restoredDatabasePath = path.join(temporaryTarget, "voice-partition.sqlite");
  await Promise.all([
    new AuthStore(path.join(temporaryTarget, "auth"), { databasePath: restoredDatabasePath }).initialize(),
    new MeetingStore(path.join(temporaryTarget, "meetings"), { databasePath: restoredDatabasePath }).initialize()
  ]);
  closeSqliteDatabases();

  const database = new DatabaseSync(restoredDatabasePath, { readOnly: true });
  const integrity = database.prepare("PRAGMA integrity_check").get();
  const requiredTables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
  database.close();
  if (integrity.integrity_check !== "ok") throw new Error(`복구 DB 무결성 검사 실패: ${integrity.integrity_check}`);
  for (const table of ["users", "organizations", "memberships", "sessions", "email_verifications", "meetings", "meeting_segments"]) {
    if (!requiredTables.has(table)) throw new Error(`복구 DB에 필수 테이블이 없습니다: ${table}`);
  }

  if (await exists(path.join(temporaryTarget, "speakers"))) {
    if (!process.env.VOICE_BIOMETRIC_KEY) throw new Error("암호화된 화자 데이터를 검증하려면 VOICE_BIOMETRIC_KEY가 필요합니다.");
    await new SpeakerStore(path.join(temporaryTarget, "speakers"), {
      encryptionKey: process.env.VOICE_BIOMETRIC_KEY,
      requireEncryption: true
    }).initialize();
  }
  await rename(temporaryTarget, target);
} catch (error) {
  await rm(temporaryTarget, { recursive: true, force: true });
  throw error;
}

console.log(JSON.stringify({ ok: true, restoredTo: target, filesVerified: manifest.files.length, createdAt: manifest.createdAt }, null, 2));
