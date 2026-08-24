import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const openDatabases = new Map();

export async function openSqliteDatabase(databasePath) {
  const resolvedPath = path.resolve(databasePath);
  const existing = openDatabases.get(resolvedPath);
  if (existing) return existing;

  await mkdir(path.dirname(resolvedPath), { recursive: true });
  const database = new DatabaseSync(resolvedPath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS legacy_imports (
      source TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL,
      record_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  openDatabases.set(resolvedPath, database);
  return database;
}

export function runTransaction(database, operation) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function closeSqliteDatabases() {
  for (const database of openDatabases.values()) database.close();
  openDatabases.clear();
}
