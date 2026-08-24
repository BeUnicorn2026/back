import { createHash } from "node:crypto";
import { openSqliteDatabase, runTransaction } from "./sqlite-database.mjs";

function hashKey(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

export class RequestRateLimiter {
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
      CREATE TABLE IF NOT EXISTS request_rate_limits (
        key_hash TEXT PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS request_rate_limits_window_idx ON request_rate_limits(window_started_at);
    `);
  }

  async consume(key, { limit, windowMs, now = Date.now() }) {
    await this.initialize();
    const keyHash = hashKey(key);
    return runTransaction(this.database, () => {
      const current = this.database.prepare("SELECT * FROM request_rate_limits WHERE key_hash = ?").get(keyHash);
      const expired = !current || now - Number(current.window_started_at) >= windowMs;
      const windowStartedAt = expired ? now : Number(current.window_started_at);
      const requestCount = expired ? 1 : Number(current.request_count) + 1;
      this.database.prepare(`INSERT INTO request_rate_limits(key_hash, window_started_at, request_count)
        VALUES (?, ?, ?) ON CONFLICT(key_hash) DO UPDATE SET
        window_started_at = excluded.window_started_at, request_count = excluded.request_count`)
        .run(keyHash, windowStartedAt, requestCount);
      if (Math.random() < 0.02) {
        this.database.prepare("DELETE FROM request_rate_limits WHERE window_started_at < ?").run(now - 86_400_000);
      }
      const retryAfterSeconds = Math.max(1, Math.ceil((windowStartedAt + windowMs - now) / 1000));
      return {
        allowed: requestCount <= limit,
        limit,
        remaining: Math.max(0, limit - requestCount),
        retryAfterSeconds,
        resetAt: new Date(windowStartedAt + windowMs).toISOString()
      };
    });
  }
}
