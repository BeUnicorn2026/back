import assert from "node:assert/strict";
import test from "node:test";
import {
  bindRoomMeeting,
  publicRoom,
  publishSelfEnrollment,
  resolveCanonicalVoice,
  validateSelfEnrollmentRequest,
  VoiceProfileError
} from "../lib/room-server-coordinator.mjs";
import { RoomLiveHub } from "../lib/room-live-hub.mjs";
import WebSocket from "ws";

const auth = {
  user: { id: "user-a", name: "Alice" },
  organization: { id: "org-a" },
  membership: { role: "member" }
};

test("canonical resolution performs exact owned lookup and invalidates dangling pointers", async () => {
  const calls = [];
  const pointer = { userId: "user-a", speakerProfileId: "speaker-a", state: "ready", version: 2 };
  const voiceProfileStore = {
    async getByUserId(id) { calls.push(["pointer", id]); return pointer; },
    async markInvalid(input) { calls.push(["invalid", input]); return { status: "updated" }; }
  };
  const speakerStore = {
    async loadOwnedProfile(id, owner) { calls.push(["exact", id, owner]); return null; },
    async list() { throw new Error("organization scan must not occur"); }
  };
  const result = await resolveCanonicalVoice({ voiceProfileStore, speakerStore, auth });
  assert.equal(result.state, "invalid");
  assert.deepEqual(calls, [
    ["pointer", "user-a"],
    ["exact", "speaker-a", "user-a"],
    ["invalid", { userId: "user-a", expectedVersion: 2 }]
  ]);
});

test("self enrollment rejects client ownership fields and removes a losing stage", async () => {
  assert.throws(() => validateSelfEnrollmentRequest({ name: "Mallory" }), VoiceProfileError);
  const removed = [];
  const speakerStore = {
    async save(metadata) {
      assert.equal(metadata.name, "Alice");
      assert.equal(metadata.createdBy, "user-a");
      assert.equal(metadata.organizationId, "org-a");
    },
    async removeOwned(id, owner) { removed.push([id, owner]); return true; }
  };
  const voiceProfileStore = {
    async getByUserId() { return null; },
    async publishInitial() { return { status: "conflict", reason: "user-already-has-profile" }; }
  };
  await assert.rejects(() => publishSelfEnrollment({
    voiceProfileStore,
    speakerStore,
    auth,
    profileBuffer: Buffer.alloc(4),
    referenceAudio: Buffer.alloc(4),
    idFactory: () => "fresh-stage"
  }), (error) => error.code === "VOICE_PROFILE_CONFLICT");
  assert.deepEqual(removed, [["fresh-stage", "user-a"]]);
});

test("room meeting binding rejects arbitrary meetings and public room omits hidden or absent access codes", async () => {
  const room = { id: "room-id", room: "AB12", accessCode: "VP-0123456789AB", status: "active" };
  assert.equal(Object.hasOwn(publicRoom(room), "accessCode"), false);
  assert.equal(publicRoom(room, { includeAccessCode: true }).accessCode, room.accessCode);
  assert.equal(Object.hasOwn(publicRoom({ ...room, accessCode: undefined }, { includeAccessCode: true }), "accessCode"), false);
  const meetingStore = {
    async bindRoomMeeting() { return null; }
  };
  await assert.rejects(() => bindRoomMeeting({
    meetingStore,
    room,
    auth,
    requestedMeetingId: "meeting-x"
  }), (error) => error.code === "ROOM_MEETING_MISMATCH");
});

function liveClient() {
  return {
    readyState: WebSocket.OPEN,
    sent: [],
    closed: [],
    send(value) { this.sent.push(JSON.parse(value)); },
    close(code, reason) { this.closed.push([code, reason]); this.readyState = WebSocket.CLOSED; }
  };
}

function bridgeRecorder() {
  const bridges = [];
  const factory = () => {
    const bridge = {
      segments: [],
      replayedSegments: [],
      finalizeCalls: 0,
      disposeCalls: 0,
      replayFinalSegment(segment) { this.replayedSegments.push(segment); },
      finishReplay() {},
      handleFinalSegment(segment) { this.segments.push(segment); },
      async finalize() { this.finalizeCalls += 1; },
      async dispose() { this.disposeCalls += 1; }
    };
    bridges.push(bridge);
    return bridge;
  };
  return { bridges, factory };
}

function hubBase(overrides = {}) {
  return {
    roomId: "room-id",
    meetingId: "meeting-id",
    loadPersistedSegments: async () => [],
    liveMapEnabled: true,
    liveMapClient: {},
    tenantKey: "tenant",
    pollIntervalMs: 1000,
    log() {},
    ...overrides
  };
}

test("room live hub shares persistence and LiveMap analysis across connected members", async () => {
  const first = liveClient();
  const second = liveClient();
  const recorded = bridgeRecorder();
  const hub = new RoomLiveHub({ idleTimeoutMs: 10_000, liveMapBridgeFactory: recorded.factory });
  const one = await hub.acquire({ ...hubBase(), client: first });
  const two = await hub.acquire({ ...hubBase(), client: second });
  let appendCalls = 0;
  const segment = { text: "accepted phrase", userId: "user-a", start: 1, end: 2 };
  const persist = async (candidate) => {
    appendCalls += 1;
    return { ...candidate, id: "accepted-1", sequence: 7 };
  };

  const [accepted, duplicate] = await Promise.all([
    one.acceptFinalSegment(segment, persist),
    two.acceptFinalSegment(segment, persist)
  ]);

  assert.equal(accepted.sequence, 7);
  assert.equal(duplicate, null);
  assert.equal(appendCalls, 1);
  assert.equal(recorded.bridges.length, 1);
  assert.deepEqual(recorded.bridges[0].segments.map(({ sequence }) => sequence), [7]);
  assert.deepEqual(first.sent, second.sent);
  assert.equal(first.sent.filter(({ type }) => type === "accepted").length, 1);
  await one.release();
  await two.release();
  await hub.closeRoom("room-id");
});

test("room live hub awaits persisted replay before accepting a new final segment", async () => {
  const recorded = bridgeRecorder();
  const hub = new RoomLiveHub({ idleTimeoutMs: 10_000, liveMapBridgeFactory: recorded.factory });
  let finishReplay;
  const replay = new Promise((resolve) => { finishReplay = resolve; });
  const acquiring = hub.acquire({
    ...hubBase({ loadPersistedSegments: () => replay }),
    client: liveClient()
  });
  await Promise.resolve();
  assert.equal(recorded.bridges[0].segments.length, 0);

  finishReplay([{ id: "old", sequence: 0, start: 0, end: 1, text: "old" }]);
  const connection = await acquiring;
  await connection.acceptFinalSegment(
    { start: 2, end: 3, text: "new" },
    async (segment) => ({ ...segment, id: "new", sequence: 1 })
  );

  assert.deepEqual(recorded.bridges[0].replayedSegments.map(({ sequence }) => sequence), [0]);
  assert.deepEqual(recorded.bridges[0].segments.map(({ sequence }) => sequence), [1]);
  await hub.closeRoom("room-id");
});

test("room recreation restores persisted LiveMap state without reposting transcript", async () => {
  const recorded = bridgeRecorder();
  const client = liveClient();
  const hub = new RoomLiveHub({ idleTimeoutMs: 10_000, liveMapBridgeFactory: recorded.factory });
  await hub.acquire({
    ...hubBase({
      loadPersistedSegments: async () => [{ sequence: 0, speaker: "Alice", start: 0, end: 1, text: "old" }],
      loadPersistedLiveMapState: async () => ({ seq: 0, result: { topics: [{ id: "persisted" }] } })
    }),
    client
  });
  assert.deepEqual(recorded.bridges[0].segments, []);
  assert.deepEqual(recorded.bridges[0].replayedSegments.map(({ text }) => text), ["old"]);
  assert.deepEqual(client.sent.find(({ type }) => type === "livemap-state"), {
    type: "livemap-state", seq: 0, result: { topics: [{ id: "persisted" }] }
  });
  await hub.closeRoom("room-id");
});

test("room live hub keeps one session through idle reconnect and replays persisted segments only after cleanup", async () => {
  const recorded = bridgeRecorder();
  const hub = new RoomLiveHub({ idleTimeoutMs: 25, liveMapBridgeFactory: recorded.factory });
  const persisted = [
    { id: "segment-2", sequence: 2, speaker: "Alice", start: 2, end: 3, text: "second" },
    { id: "segment-1", sequence: 1, speaker: "Alice", start: 0, end: 1, text: "first" }
  ];
  const first = await hub.acquire({ ...hubBase({ loadPersistedSegments: async () => persisted }), client: liveClient() });
  assert.deepEqual(recorded.bridges[0].replayedSegments.map(({ sequence }) => sequence), [1, 2]);
  await first.release();

  const reconnected = await hub.acquire({ ...hubBase({ loadPersistedSegments: async () => persisted }), client: liveClient() });
  assert.equal(recorded.bridges.length, 1);
  assert.deepEqual(recorded.bridges[0].replayedSegments.map(({ sequence }) => sequence), [1, 2]);
  await reconnected.release();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(hub.activeSessionCount(), 0);
  assert.equal(recorded.bridges[0].finalizeCalls, 1);
  assert.equal(recorded.bridges[0].disposeCalls, 1);

  const recreated = await hub.acquire({ ...hubBase({ loadPersistedSegments: async () => persisted }), client: liveClient() });
  assert.equal(recorded.bridges.length, 2);
  assert.deepEqual(recorded.bridges[1].replayedSegments.map(({ sequence }) => sequence), [1, 2]);
  assert.deepEqual(recorded.bridges[1].segments, []);
  const duplicate = await recreated.acceptFinalSegment(persisted[1], async () => {
    throw new Error("persist must not run for replayed content");
  });
  assert.equal(duplicate, null);
  await hub.closeRoom("room-id");
});

test("room live hub isolates socket and LiveMap failures after persistence", async () => {
  const goodClient = liveClient();
  const brokenClient = { readyState: WebSocket.OPEN, send() { throw new Error("socket failed"); } };
  const hub = new RoomLiveHub({
    idleTimeoutMs: 10_000,
    liveMapBridgeFactory: () => ({
      handleFinalSegment() { throw new Error("livemap failed"); },
      async finalize() {},
      async dispose() {}
    })
  });
  const first = await hub.acquire({ ...hubBase(), client: brokenClient });
  await hub.acquire({ ...hubBase(), client: goodClient });

  const accepted = await first.acceptFinalSegment(
    { start: 0, end: 1, text: "durable" },
    async (segment) => ({ ...segment, id: "durable", sequence: 0 })
  );

  assert.equal(accepted.sequence, 0);
  assert.equal(goodClient.sent.filter(({ type }) => type === "accepted").length, 1);
  await hub.closeRoom("room-id");
});

test("room live hub does not poison retries after persistence failure", async () => {
  const recorded = bridgeRecorder();
  const hub = new RoomLiveHub({ idleTimeoutMs: 10_000, liveMapBridgeFactory: recorded.factory });
  const connection = await hub.acquire({ ...hubBase(), client: liveClient() });
  const segment = { start: 0, end: 1, text: "retry" };
  await assert.rejects(() => connection.acceptFinalSegment(segment, async () => { throw new Error("store failed"); }));
  const accepted = await connection.acceptFinalSegment(
    segment,
    async (candidate) => ({ ...candidate, id: "retry", sequence: 0 })
  );
  assert.equal(accepted.sequence, 0);
  assert.equal(recorded.bridges[0].segments.length, 1);
  await hub.closeRoom("room-id");
});

test("closed-room cache is bounded and durable status still fences evicted rooms", async () => {
  let now = 1_000;
  const hub = new RoomLiveHub({
    maxClosedRooms: 2,
    closedRoomTtlMs: 10,
    nowFn: () => now,
    liveMapBridgeFactory: bridgeRecorder().factory
  });
  await hub.closeRoom("closed-a");
  await hub.closeRoom("closed-b");
  await hub.closeRoom("closed-c");
  assert.equal(hub.closedRooms.size, 2);
  await assert.rejects(() => hub.acquire({
    ...hubBase({ roomId: "closed-a", loadRoomStatus: async () => "closed" }), client: liveClient()
  }), (error) => error.code === "ROOM_CLOSED");
  now += 11;
  await assert.rejects(() => hub.acquire({
    ...hubBase({ roomId: "closed-b", loadRoomStatus: async () => "closed" }), client: liveClient()
  }), (error) => error.code === "ROOM_CLOSED");
  assert.equal(hub.closedRooms.size <= 2, true);
});

test("room cleanup persists the finalized LiveMap result best effort", async () => {
  const hub = new RoomLiveHub({
    idleTimeoutMs: 10_000,
    liveMapBridgeFactory: () => ({
      handleFinalSegment() {},
      async finalize() { return { result: { topics: [{ title: "결정" }] }, metrics: { model: "test" } }; },
      async dispose() {}
    })
  });
  const persisted = [];
  await hub.acquire({
    ...hubBase(),
    client: liveClient(),
    persistFinalizedResult: async (result) => persisted.push(result)
  });
  await hub.closeRoom("room-id");
  assert.deepEqual(persisted, [{ result: { topics: [{ title: "결정" }] }, metrics: { model: "test" } }]);
});

test("room close immediately cleans shared sessions and closes all clients", async () => {
  const recorded = bridgeRecorder();
  const hub = new RoomLiveHub({ idleTimeoutMs: 10_000, liveMapBridgeFactory: recorded.factory });
  const firstClient = liveClient();
  const secondClient = liveClient();
  await hub.acquire({ ...hubBase(), client: firstClient });
  await hub.acquire({ ...hubBase(), client: secondClient });

  await hub.closeRoom("room-id");

  assert.equal(hub.activeSessionCount(), 0);
  assert.deepEqual(firstClient.closed, [[1000, "room closed"]]);
  assert.deepEqual(secondClient.closed, [[1000, "room closed"]]);
  assert.equal(recorded.bridges[0].finalizeCalls, 1);
  assert.equal(recorded.bridges[0].disposeCalls, 1);
  await assert.rejects(
    () => hub.acquire({ ...hubBase(), client: liveClient() }),
    (error) => error.code === "ROOM_CLOSED"
  );
});
