import assert from "node:assert/strict";
import test from "node:test";
import { createLiveMapBridge, createNoopLiveMapBridge } from "../lib/livemap-live-bridge.mjs";

async function waitFor(predicate, { timeout = 1000, interval = 5 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error("waitFor timed out");
}

function statusError(status) {
  const error = new Error(`status ${status}`);
  error.status = status;
  return error;
}

// Configurable fake Go client. Records every call; overrides may throw to
// simulate failures.
function makeFakeClient(overrides = {}) {
  const calls = { create: [], turns: [], get: [], finalize: [], del: [] };
  return {
    calls,
    async createSession(args) {
      calls.create.push(args);
      if (overrides.createSession) return overrides.createSession(args, calls.create.length);
      return { session: { id: "lm_1", status: "active", seq: 0 } };
    },
    async postTurn(id, turn) {
      calls.turns.push({ id, turn });
      if (overrides.postTurn) return overrides.postTurn(id, turn, calls.turns.length);
      return { accepted: true, queued: 1 };
    },
    async getSession(id, seq) {
      calls.get.push({ id, seq });
      if (overrides.getSession) return overrides.getSession(id, seq, calls.get.length);
      return { session: { id, status: "active", seq, deltas: [] } };
    },
    async finalizeSession(id) {
      calls.finalize.push(id);
      if (overrides.finalizeSession) return overrides.finalizeSession(id);
      return { session: { id, status: "finalized" }, result: { topics: [] }, metrics: {} };
    },
    async deleteSession(id) {
      calls.del.push(id);
      return { status: 204 };
    }
  };
}

function seg(speaker, start, end, text) {
  return { speaker, start, end, text };
}

test("happy path: turns are posted and deltas relayed in seq order", async () => {
  const sends = [];
  const client = makeFakeClient({
    getSession: (id, seq, callCount) => callCount === 1
      ? { session: { id, status: "active", seq: 2, deltas: [
          { seq: 1, type: "topic_started", label: "안건" },
          { seq: 2, type: "node_added", nodeId: "n1" }
        ] } }
      : { session: { id, status: "active", seq: 2, deltas: [] } }
  });
  const bridge = createLiveMapBridge({ client, send: (payload) => sends.push(payload), tenantKey: "org-1:user-1", pollIntervalMs: 10 });

  // Speaker change finalizes turn-1 (민수); turn-2 (지현) stays pending.
  bridge.handleFinalSegment(seg("민수", 0, 1, "안건을 정합니다"));
  bridge.handleFinalSegment(seg("지현", 1.1, 2, "동의합니다"));

  await waitFor(() => client.calls.turns.length >= 1);
  assert.equal(client.calls.create.length, 1);
  assert.equal(client.calls.turns[0].turn.turnId, "turn-1");
  assert.equal(client.calls.turns[0].turn.text, "안건을 정합니다");

  await waitFor(() => sends.filter((s) => s.type === "livemap-delta").length >= 2);
  const deltas = sends.filter((s) => s.type === "livemap-delta");
  assert.deepEqual(deltas.map((d) => d.delta.seq), [1, 2]);

  const final = await bridge.finalize();
  assert.ok(final);
  // Pending turn-2 flushed on finalize.
  assert.equal(client.calls.turns.length, 2);
  assert.equal(client.calls.turns[1].turn.turnId, "turn-2");
  assert.equal(client.calls.finalize.length, 1);
  assert.equal(bridge.hasActivePoll(), false);
});

test("persisted replay restores local state without reposting historical turns", async () => {
  const client = makeFakeClient();
  const bridge = createLiveMapBridge({ client, send: () => {}, tenantKey: "tenant", pollIntervalMs: 10 });
  bridge.replayFinalSegment(seg("민수", 0, 1, "old one"));
  bridge.replayFinalSegment(seg("지현", 2, 3, "old two"));
  bridge.finishReplay();
  await bridge.finalize();
  assert.equal(client.calls.create.length, 0);
  assert.equal(client.calls.turns.length, 0);
  assert.equal(client.calls.finalize.length, 0);
});

test("resync emits a livemap-state snapshot", async () => {
  const sends = [];
  const client = makeFakeClient({
    getSession: (id, seq, callCount) => callCount === 1
      ? { session: { id, status: "active", seq: 5, resync: true, result: { topics: [{ id: "t1" }] }, deltas: [] } }
      : { session: { id, status: "active", seq: 5, deltas: [] } }
  });
  const bridge = createLiveMapBridge({ client, send: (payload) => sends.push(payload), tenantKey: "org-1:user-1", pollIntervalMs: 10 });

  bridge.handleFinalSegment(seg("민수", 0, 1, "시작"));
  bridge.handleFinalSegment(seg("지현", 1.1, 2, "다음"));

  await waitFor(() => sends.some((s) => s.type === "livemap-state"));
  const state = sends.find((s) => s.type === "livemap-state");
  assert.equal(state.seq, 5);
  assert.deepEqual(state.result, { topics: [{ id: "t1" }] });
  await bridge.dispose();
});

test("Go down at session create disables the bridge, never emits livemap types, never throws", async () => {
  const sends = [];
  const client = makeFakeClient({ createSession: () => { throw statusError(503); } });
  const bridge = createLiveMapBridge({ client, send: (payload) => sends.push(payload), tenantKey: "org-1:user-1", pollIntervalMs: 10 });

  assert.doesNotThrow(() => bridge.handleFinalSegment(seg("민수", 0, 1, "가")));
  bridge.handleFinalSegment(seg("지현", 1.1, 2, "나"));

  await waitFor(() => bridge.disabled);
  assert.equal(bridge.hasActivePoll(), false);
  assert.equal(client.calls.turns.length, 0);
  // Give any stray poll a chance — none should ever fire.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sends.some((s) => s.type === "livemap-delta" || s.type === "livemap-state"), false);
  await bridge.dispose();
});

test("three consecutive turn-post failures disable the bridge", async () => {
  const client = makeFakeClient({ postTurn: () => { throw statusError(500); } });
  const bridge = createLiveMapBridge({ client, send: () => {}, tenantKey: "org-1:user-1", pollIntervalMs: 10 });

  // Alternating speakers finalize three turns during streaming.
  bridge.handleFinalSegment(seg("민수", 0, 1, "가"));
  bridge.handleFinalSegment(seg("지현", 1.1, 2, "나"));
  bridge.handleFinalSegment(seg("민수", 2.2, 3, "다"));
  bridge.handleFinalSegment(seg("지현", 3.3, 4, "라"));

  await waitFor(() => bridge.disabled);
  assert.equal(client.calls.turns.length, 3);
  assert.equal(bridge.hasActivePoll(), false);
});

test("backpressure (429) drops the turn without disabling", async () => {
  const client = makeFakeClient({ postTurn: () => { throw statusError(429); } });
  const bridge = createLiveMapBridge({ client, send: () => {}, tenantKey: "org-1:user-1", pollIntervalMs: 10 });

  bridge.handleFinalSegment(seg("민수", 0, 1, "가"));
  bridge.handleFinalSegment(seg("지현", 1.1, 2, "나"));
  bridge.handleFinalSegment(seg("민수", 2.2, 3, "다"));
  bridge.handleFinalSegment(seg("지현", 3.3, 4, "라"));

  await waitFor(() => client.calls.turns.length >= 3);
  assert.equal(bridge.disabled, false);
  await bridge.dispose();
});

test("finalize flushes the pending turn and returns result + metrics", async () => {
  const client = makeFakeClient({
    finalizeSession: (id) => ({ session: { id, status: "finalized" }, result: { topics: [{ id: "t1", nodes: [] }] }, metrics: { model: "m1" } })
  });
  const bridge = createLiveMapBridge({ client, send: () => {}, tenantKey: "org-1:user-1", pollIntervalMs: 10 });

  // Single ongoing turn — only flushed at finalize.
  bridge.handleFinalSegment(seg("민수", 0, 1, "마무리"));
  const final = await bridge.finalize();

  assert.equal(client.calls.turns.length, 1);
  assert.equal(client.calls.turns[0].turn.turnId, "turn-1");
  assert.deepEqual(final.result.topics, [{ id: "t1", nodes: [] }]);
  assert.equal(final.metrics.model, "m1");
  assert.equal(client.calls.del.length, 1);
  // Idempotent.
  assert.equal(await bridge.finalize(), final);
  assert.equal(client.calls.finalize.length, 1);
});

test("dispose stops the poll loop with no timer leak", async () => {
  const client = makeFakeClient();
  const bridge = createLiveMapBridge({ client, send: () => {}, tenantKey: "org-1:user-1", pollIntervalMs: 10 });

  bridge.handleFinalSegment(seg("민수", 0, 1, "가"));
  bridge.handleFinalSegment(seg("지현", 1.1, 2, "나"));

  await waitFor(() => bridge.hasActivePoll());
  await bridge.dispose();
  assert.equal(bridge.hasActivePoll(), false);
  assert.equal(client.calls.del.length, 1);
});

test("the no-op bridge issues no requests and reports disabled", async () => {
  const bridge = createNoopLiveMapBridge();
  assert.doesNotThrow(() => bridge.handleFinalSegment(seg("민수", 0, 1, "가")));
  assert.equal(await bridge.finalize(), null);
  assert.equal(bridge.hasActivePoll(), false);
  assert.equal(bridge.disabled, true);
  await bridge.dispose();
});
