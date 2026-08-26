import { createTurnBuilder } from "./livemap-turn-builder.mjs";

// A bridge that does nothing: used when LiveMap is disabled so the live WS
// handler pays zero overhead and issues zero requests.
export function createNoopLiveMapBridge() {
  return {
    replayFinalSegment() {},
    finishReplay() {},
    handleFinalSegment() {},
    async finalize() { return null; },
    async dispose() {},
    hasActivePoll() { return false; },
    get disabled() { return true; }
  };
}

// Orchestrator between the live transcript stream and the Go livemap session
// API. Dependency-injected (client + send + log) so it is fully unit-testable.
//
// Invariants that protect the transcription flow: EVERY failure path here is
// silent to the caller. handleFinalSegment never throws, finalize()/dispose()
// resolve to null rather than rejecting, and no error ever propagates out. If Go
// is down, slow, or misbehaving the live captioning is 100% unaffected.
export function createLiveMapBridge({
  client,
  send,
  tenantKey,
  meetingId = null,
  log = () => {},
  pollIntervalMs = 1_000
} = {}) {
  const builder = createTurnBuilder();
  let disabled = false;
  let disposed = false;
  let finalized = false;
  let session = null;            // { id, status }
  let creating = null;           // in-flight createSession promise
  let lastSeq = 0;
  let consecutiveFailures = 0;
  let backpressureLogged = false;
  let turnChain = Promise.resolve();
  let pollTimer = null;
  let polling = false;
  let finalizeResult = null;
  let replaying = true;

  function safeSend(payload) {
    try { send(payload); } catch { /* never let a send failure reach transcription */ }
  }

  function disable(reason) {
    if (disabled) return;
    disabled = true;
    stopPolling();
    log({ event: "livemap_bridge_disabled", reason });
  }

  function startPolling() {
    if (pollTimer || disabled) return;
    pollTimer = setInterval(() => { void pollOnce(); }, pollIntervalMs);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function markRemoteFinalized() {
    if (session) session.status = "finalized";
    stopPolling();
  }

  async function ensureSession() {
    if (session) return session;
    if (disabled) return null;
    if (!creating) {
      creating = (async () => {
        try {
          const response = await client.createSession({ meetingId: meetingId || "", agenda: [], tenantKey });
          const created = response?.session;
          if (!created?.id) throw new Error("invalid session response");
          session = { id: String(created.id), status: created.status || "active" };
          lastSeq = Number(created.seq) || 0;
          startPolling();
          return session;
        } catch {
          // First finalized turn could not open a session: disable permanently
          // for this connection (one log line via disable()).
          disable("session_create_failed");
          return null;
        } finally {
          creating = null;
        }
      })();
    }
    return creating;
  }

  async function postTurn(turn) {
    if (disabled) return;
    const active = await ensureSession();
    if (!active || disabled) return;
    try {
      await client.postTurn(active.id, turn, tenantKey);
      consecutiveFailures = 0;
    } catch (error) {
      const status = Number(error?.status) || 0;
      if (status === 429) {
        // Backpressure: drop this turn and log once. Not a hard failure.
        if (!backpressureLogged) {
          backpressureLogged = true;
          log({ event: "livemap_turn_backpressure" });
        }
        return;
      }
      if (status === 409) {
        // Go finalized the session out from under us: stop cleanly.
        markRemoteFinalized();
        return;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures >= 3) disable("turn_post_failures");
    }
  }

  function enqueueTurn(turn) {
    turnChain = turnChain.then(() => postTurn(turn)).catch(() => {});
    return turnChain;
  }

  async function pollOnce() {
    if (polling || disabled || finalized) return;
    if (!session || session.status !== "active") return;
    polling = true;
    try {
      const response = await client.getSession(session.id, lastSeq, tenantKey);
      const remote = response?.session;
      if (!remote) return;
      if (remote.resync) {
        safeSend({ type: "livemap-state", seq: Number(remote.seq) || 0, result: remote.result ?? null });
        lastSeq = Number(remote.seq) || 0;
      }
      const deltas = Array.isArray(remote.deltas) ? remote.deltas : [];
      for (const delta of deltas) {
        const deltaSeq = Number(delta?.seq);
        // On a resync the state snapshot already covers everything up to its seq.
        if (remote.resync && Number.isFinite(deltaSeq) && deltaSeq <= lastSeq) continue;
        safeSend({ type: "livemap-delta", delta });
        if (Number.isFinite(deltaSeq)) lastSeq = Math.max(lastSeq, deltaSeq);
        if (delta?.type === "finalized") markRemoteFinalized();
      }
      if (remote.status && remote.status !== "active") {
        session.status = remote.status;
        stopPolling();
      }
    } catch {
      // Polling errors are silent: a transient Go outage must not disturb the
      // live captioning, and the next tick simply retries.
    } finally {
      polling = false;
    }
  }

  function replayFinalSegment(segment) {
    if (disabled || finalized || !replaying) return;
    // Restore turn-builder continuity only. Historical persisted transcript has
    // already reached analysis and must never be posted again after reconnect.
    builder.push(segment);
  }

  function finishReplay() {
    if (!replaying) return;
    replaying = false;
    // Historical text is never eligible for posting or finalization. Replay is
    // used only to restore hub dedupe/order state; a new live turn starts cleanly.
    builder.discardPending();
  }

  function handleFinalSegment(segment) {
    if (disabled || finalized) return;
    if (replaying) finishReplay();
    for (const finalizedTurn of builder.push(segment).finalizedTurns) enqueueTurn(finalizedTurn);
  }

  async function deleteBestEffort() {
    if (!session) return;
    try { await client.deleteSession(session.id, tenantKey); } catch { /* best effort */ }
  }

  async function finalize() {
    if (finalized) return finalizeResult;
    finalized = true;
    stopPolling();

    const { finalizedTurn } = builder.flush();
    if (finalizedTurn) enqueueTurn(finalizedTurn);
    await turnChain.catch(() => {});

    if (disabled || !session) {
      await deleteBestEffort();
      finalizeResult = null;
      return null;
    }
    try {
      const response = await client.finalizeSession(session.id, tenantKey);
      finalizeResult = { result: response?.result ?? null, metrics: response?.metrics ?? null };
    } catch {
      finalizeResult = null;
    }
    await deleteBestEffort();
    return finalizeResult;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    stopPolling();
    if (finalized) return;   // finalize() already tore the session down
    finalized = true;
    await deleteBestEffort();
  }

  return {
    replayFinalSegment,
    finishReplay,
    handleFinalSegment,
    finalize,
    dispose,
    hasActivePoll() { return pollTimer !== null; },
    get disabled() { return disabled; }
  };
}
