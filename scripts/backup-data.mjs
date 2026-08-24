import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { backup, DatabaseSync } from "node:sqlite";
import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

async function exists(target) {
  try { await stat(target); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function walk(root, current = root) {
  if (!(await exists(current))) return [];
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
  return files.sort();
}

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDirectory = process.env.VOICE_PARTITION_DATA_DIR
  ? path.resolve(process.env.VOICE_PARTITION_DATA_DIR)
  : path.join(projectDirectory, ".data");
const databasePath = process.env.VOICE_PARTITION_DATABASE_PATH
  ? path.resolve(process.env.VOICE_PARTITION_DATABASE_PATH)
  : path.join(dataDirectory, "voice-partition.sqlite");
const outputDirectory = option("--output");
const allowsPlaintext = process.argv.includes("--allow-plaintext");
const databaseOnly = process.argv.includes("--database-only");

if (process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL 사용 중에는 SQLite 백업 명령을 실행할 수 없습니다. 관리형 PostgreSQL 공급자의 PITR/백업을 사용하세요.");
}

if (!outputDirectory || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: npm run backup:data -- --output <new-directory> [--allow-plaintext] [--database-only]");
  process.exit(outputDirectory ? 0 : 2);
}
if (!(await exists(databasePath))) throw new Error(`데이터베이스를 찾지 못했습니다: ${databasePath}`);
if ((process.env.SPEAKER_STORAGE === "blob" || process.env.BLOB_READ_WRITE_TOKEN) && !databaseOnly) {
  throw new Error("Blob 화자 저장소는 별도 보존 정책이 필요합니다. DB만 백업하려면 --database-only를 명시하세요.");
}

const resolvedOutput = path.resolve(outputDirectory);
if (await exists(resolvedOutput)) throw new Error(`백업 대상은 존재하지 않는 새 경로여야 합니다: ${resolvedOutput}`);

const speakerDirectory = path.join(dataDirectory, "speakers");
const speakerFiles = await walk(speakerDirectory);
const plaintext = speakerFiles.filter((file) => /(^|\/)(profile\.bin|reference\.wav)$/.test(file));
if (plaintext.length && !allowsPlaintext) {
  throw new Error(`평문 생체정보 ${plaintext.length}개가 있어 백업을 중단했습니다. 먼저 암호화 이관을 실행하세요.`);
}

const temporaryDirectory = `${resolvedOutput}.tmp-${randomUUID()}`;
await mkdir(temporaryDirectory, { recursive: true });
const sourceDatabase = new DatabaseSync(databasePath, { readOnly: true });
try {
  await backup(sourceDatabase, path.join(temporaryDirectory, "voice-partition.sqlite"));
} finally {
  sourceDatabase.close();
}

if (speakerFiles.length) await cp(speakerDirectory, path.join(temporaryDirectory, "speakers"), { recursive: true });
for (const [source, destination] of [
  [path.join(dataDirectory, "auth", "auth.json"), path.join(temporaryDirectory, "legacy", "auth.json")],
  [path.join(dataDirectory, "meetings", "meetings.json"), path.join(temporaryDirectory, "legacy", "meetings.json")]
]) {
  if (await exists(source)) {
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination);
  }
}

const files = [];
for (const relativePath of await walk(temporaryDirectory)) {
  const contents = await readFile(path.join(temporaryDirectory, relativePath));
  files.push({ path: relativePath, bytes: contents.length, sha256: createHash("sha256").update(contents).digest("hex") });
}
const integrity = new DatabaseSync(path.join(temporaryDirectory, "voice-partition.sqlite"), { readOnly: true });
const integrityResult = integrity.prepare("PRAGMA integrity_check").get();
integrity.close();
if (integrityResult.integrity_check !== "ok") throw new Error(`SQLite 무결성 검사 실패: ${integrityResult.integrity_check}`);

await writeFile(path.join(temporaryDirectory, "manifest.json"), JSON.stringify({
  version: 1,
  createdAt: new Date().toISOString(),
  sourceDatabase: path.basename(databasePath),
  biometricStorage: plaintext.length ? "plaintext-explicitly-allowed" : "encrypted-or-empty",
  speakerStorage: databaseOnly ? "external-not-included" : "local-included",
  files
}, null, 2));
await rename(temporaryDirectory, resolvedOutput);
console.log(JSON.stringify({ ok: true, output: resolvedOutput, files: files.length, biometricStorage: plaintext.length ? "plaintext" : "encrypted-or-empty" }, null, 2));
