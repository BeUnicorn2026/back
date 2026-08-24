import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RequestRateLimiter } from "../lib/request-rate-limiter.mjs";

test("enforces a persistent fixed-window limit and resets after the window", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-rate-limit-"));
  try {
    const databasePath = path.join(root, "app.sqlite");
    const limiter = new RequestRateLimiter(databasePath);
    const options = { limit: 2, windowMs: 1_000, now: 10_000 };
    assert.deepEqual((await limiter.consume("login:address:user", options)).allowed, true);
    assert.equal((await limiter.consume("login:address:user", options)).remaining, 0);
    const rejected = await limiter.consume("login:address:user", options);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.retryAfterSeconds, 1);

    const secondInstance = new RequestRateLimiter(databasePath);
    assert.equal((await secondInstance.consume("login:address:user", { ...options, now: 11_001 })).allowed, true);
    assert.equal((await secondInstance.consume("login:address:other", options)).allowed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
