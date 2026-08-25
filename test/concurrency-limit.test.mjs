import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createConcurrencyLimit } from "../lib/concurrency-limit.mjs";

function response() {
  const result = new EventEmitter();
  result.headers = {};
  result.set = (name, value) => { result.headers[name] = value; return result; };
  result.status = (status) => { result.statusCode = status; return result; };
  result.json = (body) => { result.body = body; return result; };
  return result;
}

test("rejects excess concurrent work and releases capacity once", () => {
  const middleware = createConcurrencyLimit(1, { code: "BUSY", retryAfterSeconds: 7 });
  const first = response();
  let firstStarted = false;
  middleware({}, first, () => { firstStarted = true; });
  assert.equal(firstStarted, true);

  const blocked = response();
  middleware({}, blocked, () => assert.fail("excess work must not start"));
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.headers["Retry-After"], "7");
  assert.equal(blocked.body.code, "BUSY");

  first.emit("finish");
  first.emit("close");
  const next = response();
  let nextStarted = false;
  middleware({}, next, () => { nextStarted = true; });
  assert.equal(nextStarted, true);
});
