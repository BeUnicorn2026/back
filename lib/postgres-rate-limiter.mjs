import { createHash } from "node:crypto";

function hashKey(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

export class PostgresRequestRateLimiter {
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
      CREATE TABLE IF NOT EXISTS request_rate_limits (
        key_hash TEXT PRIMARY KEY,
        window_started_at BIGINT NOT NULL,
        request_count INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS request_rate_limits_window_idx ON request_rate_limits(window_started_at);
    `);
  }

  async consume(key, { limit, windowMs, now = Date.now() }) {
    await this.initialize();
    const keyHash = hashKey(key);
    const result = await this.database.query(`INSERT INTO request_rate_limits(key_hash, window_started_at, request_count)
      VALUES ($1, $2, 1)
      ON CONFLICT(key_hash) DO UPDATE SET
        request_count = CASE
          WHEN $2 - request_rate_limits.window_started_at >= $3 THEN 1
          ELSE request_rate_limits.request_count + 1
        END,
        window_started_at = CASE
          WHEN $2 - request_rate_limits.window_started_at >= $3 THEN $2
          ELSE request_rate_limits.window_started_at
        END
      RETURNING window_started_at, request_count`, [keyHash, Math.trunc(now), Math.trunc(windowMs)]);
    const row = result.rows[0];
    const windowStartedAt = Number(row.window_started_at);
    const requestCount = Number(row.request_count);
    if (Math.random() < 0.02) {
      this.database.query("DELETE FROM request_rate_limits WHERE window_started_at < $1", [now - 86_400_000])
        .catch(() => undefined);
    }
    return {
      allowed: requestCount <= limit,
      limit,
      remaining: Math.max(0, limit - requestCount),
      retryAfterSeconds: Math.max(1, Math.ceil((windowStartedAt + windowMs - now) / 1000)),
      resetAt: new Date(windowStartedAt + windowMs).toISOString()
    };
  }
}
