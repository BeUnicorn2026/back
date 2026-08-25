import WebSocket from "ws";
import { createLiveMapBridge, createNoopLiveMapBridge } from "./livemap-live-bridge.mjs";

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSED_ROOM_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_CLOSED_ROOMS = 1_000;

function segmentContentKey(segment) {
  return JSON.stringify([
    segment?.userId ?? null,
    segment?.speakerProfileId ?? null,
    segment?.sourceSpeaker ?? null,
    Number(segment?.start) || 0,
    Number(segment?.end) || 0,
    String(segment?.text || "").trim()
  ]);
}

function canonicalSegmentKey(segment) {
  if (segment?.sequence != null && segment.sequence !== "") {
    const sequence = Number(segment.sequence);
    if (Number.isSafeInteger(sequence) && sequence >= 0) return `sequence:${sequence}`;
  }
  if (segment?.id != null && String(segment.id)) return `id:${String(segment.id)}`;
  return `content:${segmentContentKey(segment)}`;
}

export class RoomLiveHubError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoomLiveHubError";
    this.code = code;
  }
}

function orderedSegments(segments) {
  return [...(Array.isArray(segments) ? segments : [])].sort((left, right) => {
    const leftSequence = Number(left?.sequence);
    const rightSequence = Number(right?.sequence);
    if (Number.isSafeInteger(leftSequence) && Number.isSafeInteger(rightSequence)) {
      return leftSequence - rightSequence;
    }
    return (Number(left?.start) || 0) - (Number(right?.start) || 0);
  });
}

/** Shares one ordered output/LiveMap stream per room meeting across member sockets. */
export class RoomLiveHub {
  constructor({
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    liveMapBridgeFactory = createLiveMapBridge,
    noopLiveMapBridgeFactory = createNoopLiveMapBridge,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    closedRoomTtlMs = DEFAULT_CLOSED_ROOM_TTL_MS,
    maxClosedRooms = DEFAULT_MAX_CLOSED_ROOMS,
    nowFn = Date.now
  } = {}) {
    const timeout = Number(idleTimeoutMs);
    this.idleTimeoutMs = Number.isFinite(timeout) ? Math.max(0, timeout) : DEFAULT_IDLE_TIMEOUT_MS;
    this.liveMapBridgeFactory = liveMapBridgeFactory;
    this.noopLiveMapBridgeFactory = noopLiveMapBridgeFactory;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.closedRoomTtlMs = Math.max(1, Number(closedRoomTtlMs) || DEFAULT_CLOSED_ROOM_TTL_MS);
    this.maxClosedRooms = Math.max(1, Number(maxClosedRooms) || DEFAULT_MAX_CLOSED_ROOMS);
    this.nowFn = nowFn;
    this.sessions = new Map();
    this.closedRooms = new Map();
  }

  async acquire({
    roomId,
    meetingId,
    client,
    loadPersistedSegments,
    liveMapClient,
    liveMapEnabled,
    tenantKey,
    pollIntervalMs,
    log,
    persistFinalizedResult,
    loadPersistedLiveMapState,
    loadRoomStatus
  }) {
    this.#pruneClosedRooms();
    if (this.#isRecentlyClosed(roomId)) {
      throw new RoomLiveHubError("ROOM_CLOSED", "종료된 방입니다.");
    }
    if (loadRoomStatus && await loadRoomStatus() !== "active") {
      this.#rememberClosedRoom(roomId);
      throw new RoomLiveHubError("ROOM_CLOSED", "종료된 방입니다.");
    }
    // closeRoom may have run while the durable status lookup was in flight.
    if (this.#isRecentlyClosed(roomId)) {
      throw new RoomLiveHubError("ROOM_CLOSED", "종료된 방입니다.");
    }
    const key = `${roomId}:${meetingId}`;
    let session;

    // An idle teardown cannot be revived after finalization starts. Waiting for it
    // prevents old and replayed LiveMap sessions from overlapping for one meeting.
    while (true) {
      session = this.sessions.get(key);
      if (!session?.closing) break;
      await session.closing;
      if (this.#isRecentlyClosed(roomId)) {
        throw new RoomLiveHubError("ROOM_CLOSED", "종료된 방입니다.");
      }
    }

    if (!session) {
      session = this.#createSession({
        key,
        roomId,
        meetingId,
        loadPersistedSegments,
        liveMapClient,
        liveMapEnabled,
        tenantKey,
        pollIntervalMs,
        log,
        persistFinalizedResult,
        loadPersistedLiveMapState
      });
      this.sessions.set(key, session);
    }

    this.#cancelIdleCleanup(session);
    session.clients.add(client);
    try {
      await session.ready;
      if (this.#isRecentlyClosed(roomId) || session.closing) {
        throw new RoomLiveHubError("ROOM_CLOSED", "종료된 방입니다.");
      }
    } catch (error) {
      session.clients.delete(client);
      if (!session.clients.size) await this.#cleanup(session);
      throw error;
    }

    let released = false;
    return {
      acceptFinalSegment: (segment, persist) => {
        if (released || session.acceptanceClosed) {
          return Promise.reject(new RoomLiveHubError("ROOM_SESSION_CLOSED", "종료 중인 방 연결입니다."));
        }
        const candidateKey = segmentContentKey(segment);
        const append = session.appendChain.then(async () => {
          if (session.acceptanceClosed) {
            throw new RoomLiveHubError("ROOM_SESSION_CLOSED", "종료 중인 방 연결입니다.");
          }
          if (session.acceptedKeys.has(canonicalSegmentKey(segment)) || session.candidateKeys.has(candidateKey)) return null;
          session.candidateKeys.add(candidateKey);
          let accepted;
          try {
            accepted = await persist(segment);
          } catch (error) {
            session.candidateKeys.delete(candidateKey);
            throw error;
          }
          if (!accepted) {
            session.candidateKeys.delete(candidateKey);
            throw new Error("진행 중인 방 회의에 발화를 저장하지 못했습니다.");
          }
          session.acceptAccepted(accepted, true);
          return accepted;
        });
        session.appendChain = append.catch(() => undefined);
        return append;
      },
      release: async () => {
        if (released) return;
        released = true;
        session.clients.delete(client);
        if (!session.clients.size) this.#scheduleIdleCleanup(session);
      }
    };
  }

  async closeRoom(roomId) {
    this.#rememberClosedRoom(roomId);
    const sessions = [...this.sessions.values()].filter((session) => session.roomId === roomId);
    for (const session of sessions) session.acceptanceClosed = true;
    await Promise.all(sessions.map(async (session) => {
      for (const client of session.clients) {
        try {
          if (client.readyState === WebSocket.OPEN) client.close(1000, "room closed");
        } catch { /* Continue closing the remaining members. */ }
      }
      session.clients.clear();
      await this.#cleanup(session);
    }));
  }

  activeSessionCount() {
    return this.sessions.size;
  }

  #pruneClosedRooms() {
    const cutoff = this.nowFn() - this.closedRoomTtlMs;
    for (const [roomId, closedAt] of this.closedRooms) {
      if (closedAt > cutoff) break;
      this.closedRooms.delete(roomId);
    }
    while (this.closedRooms.size > this.maxClosedRooms) {
      this.closedRooms.delete(this.closedRooms.keys().next().value);
    }
  }

  #isRecentlyClosed(roomId) {
    this.#pruneClosedRooms();
    return this.closedRooms.has(roomId);
  }

  #rememberClosedRoom(roomId) {
    this.closedRooms.delete(roomId);
    this.closedRooms.set(roomId, this.nowFn());
    this.#pruneClosedRooms();
  }

  #createSession({
    key,
    roomId,
    meetingId,
    loadPersistedSegments,
    liveMapClient,
    liveMapEnabled,
    tenantKey,
    pollIntervalMs,
    log,
    persistFinalizedResult,
    loadPersistedLiveMapState
  }) {
    const session = {
      key,
      roomId,
      meetingId,
      clients: new Set(),
      acceptedKeys: new Set(),
      candidateKeys: new Set(),
      appendChain: Promise.resolve(),
      acceptanceClosed: false,
      idleTimer: null,
      closing: null,
      bridge: null,
      ready: null,
      persistFinalizedResult,
      broadcast(payload) {
        const encoded = JSON.stringify(payload);
        for (const member of this.clients) {
          try {
            if (member.readyState === WebSocket.OPEN) member.send(encoded);
          } catch { /* One broken member must not block the room. */ }
        }
      },
      acceptAccepted(segment, shouldBroadcast) {
        const keyForSegment = canonicalSegmentKey(segment);
        if (this.acceptedKeys.has(keyForSegment)) return false;
        this.acceptedKeys.add(keyForSegment);
        // Replayed content is historical context, not a live candidate. Keeping
        // its content key would suppress a legitimate repeated phrase after a
        // reconnect merely because the words and provider timestamps match.
        if (shouldBroadcast) this.candidateKeys.add(segmentContentKey(segment));
        try {
          if (shouldBroadcast) this.bridge.handleFinalSegment(segment);
          else this.bridge.replayFinalSegment?.(segment);
        } catch { /* Persistence is authoritative. */ }
        if (shouldBroadcast) {
          this.broadcast({ type: "accepted", roomId, meetingId, segment });
          this.broadcast({ type: "transcript", isFinal: true, speechFinal: true, roomId, meetingId, segments: [segment] });
        }
        return true;
      }
    };

    session.bridge = liveMapEnabled
      ? this.liveMapBridgeFactory({
        client: liveMapClient,
        send: (payload) => session.broadcast(payload),
        tenantKey,
        meetingId,
        pollIntervalMs,
        log
      })
      : this.noopLiveMapBridgeFactory();
    session.ready = Promise.resolve()
      .then(() => loadPersistedSegments?.())
      .then(async (segments) => {
        for (const segment of orderedSegments(segments)) session.acceptAccepted(segment, false);
        session.bridge.finishReplay?.();
        const persistedState = await loadPersistedLiveMapState?.();
        if (persistedState) session.broadcast({ type: "livemap-state", ...persistedState });
      });
    return session;
  }

  #cancelIdleCleanup(session) {
    if (!session.idleTimer) return;
    this.clearTimeoutFn(session.idleTimer);
    session.idleTimer = null;
  }

  #scheduleIdleCleanup(session) {
    if (session.idleTimer || session.closing || this.sessions.get(session.key) !== session) return;
    session.idleTimer = this.setTimeoutFn(() => {
      session.idleTimer = null;
      if (!session.clients.size && this.sessions.get(session.key) === session) {
        session.acceptanceClosed = true;
        void this.#cleanup(session);
      }
    }, this.idleTimeoutMs);
    if (typeof session.idleTimer?.unref === "function") session.idleTimer.unref();
  }

  #cleanup(session) {
    if (session.closing) return session.closing;
    session.acceptanceClosed = true;
    this.#cancelIdleCleanup(session);
    session.closing = (async () => {
      try {
        await session.ready;
        await session.appendChain;
        const finalizedResult = await session.bridge.finalize();
        if (finalizedResult && session.persistFinalizedResult) {
          await session.persistFinalizedResult(finalizedResult);
        }
      } catch {
        // Accepted persistence is authoritative; LiveMap cleanup is best effort.
      } finally {
        try { await session.bridge.dispose(); } catch { /* best effort */ }
        if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
      }
    })();
    return session.closing;
  }
}
