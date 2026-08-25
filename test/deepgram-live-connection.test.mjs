import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeepgramKeepAlive, deepgramApplicationError, deepgramKeepAliveIntervalMs,
  parseDeepgramLiveEvent
} from "../lib/deepgram-live-connection.mjs";

test("sends text KeepAlive only after audio forwarding has been idle", () => {
  let now = 0;
  let tick;
  let cleared = null;
  const sent = [];
  const keepAlive = createDeepgramKeepAlive({
    readyState: 1,
    send(payload) { sent.push(payload); }
  }, {
    now: () => now,
    setInterval(callback, interval) { tick = callback; assert.equal(interval, deepgramKeepAliveIntervalMs); return 27; },
    clearInterval(timer) { cleared = timer; }
  });
  now = 2_999;
  tick();
  assert.deepEqual(sent, []);
  now = 3_000;
  tick();
  assert.deepEqual(sent, [JSON.stringify({ type: "KeepAlive" })]);
  keepAlive.markAudioForwarded();
  now = 5_999;
  tick();
  assert.equal(sent.length, 1);
  keepAlive.stop();
  keepAlive.stop();
  assert.equal(cleared, 27);
});

test("does not send KeepAlive through a closed provider socket", () => {
  let tick;
  let sent = false;
  createDeepgramKeepAlive({ readyState: 3, send() { sent = true; } }, {
    now: () => 10_000,
    setInterval(callback) { tick = callback; return 1; },
    clearInterval() {}
  });
  tick();
  assert.equal(sent, false);
});

test("parses provider events without allowing malformed payloads to throw", () => {
  assert.deepEqual(parseDeepgramLiveEvent(Buffer.from('{"type":"Results"}')), {
    ok: true, event: { type: "Results" }
  });
  assert.deepEqual(parseDeepgramLiveEvent("not-json"), { ok: false, reason: "invalid_json" });
  assert.deepEqual(parseDeepgramLiveEvent("[]"), { ok: false, reason: "invalid_shape" });
});

test("normalizes provider application errors without exposing raw descriptions", () => {
  assert.deepEqual(deepgramApplicationError({
    type: "Error", err_code: "INVALID_QUERY", description: "secret upstream detail"
  }), {
    code: "INVALID_QUERY",
    message: "실시간 STT 제공자가 요청을 처리하지 못했습니다 (INVALID_QUERY). 잠시 후 다시 시도해 주세요."
  });
  assert.equal(deepgramApplicationError({ type: "Metadata" }), null);
});
