import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import WebSocket from "ws";
import { handleSelfOnlyRoomLive } from "../lib/room-live-connection.mjs";

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.sent = [];
  }

  send(value, callback) {
    this.sent.push(value);
    callback?.();
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

function voicedPcm(sampleRate, seconds) {
  const samples = new Int16Array(sampleRate * seconds);
  const frameSamples = Math.round(sampleRate * 0.02);
  for (let index = 0; index < samples.length; index += 1) {
    const frame = Math.floor(index / frameSamples);
    if (frame % 5 !== 0) {
      samples[index] = Math.round(Math.sin(index * 0.17) * 6_000);
    }
  }
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

async function waitForMessage(socket, type) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const message = socket.sent
      .map((value) => JSON.parse(String(value)))
      .find((value) => value.type === type);
    if (message) return message;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`Timed out waiting for ${type}`);
}

test("accepted canonical phrase persists and reaches room output exactly once", async () => {
  const acceptedPhrase = "verified owner phrase";
  const client = new FakeSocket();
  const provider = new FakeSocket();
  const persisted = [];
  const liveMap = [];

  try {
    await handleSelfOnlyRoomLive({
      client,
      requestUrl: new URL("http://localhost/api/live?roomId=room-a"),
      auth: {
        user: { id: "user-owner", name: "Owner" },
        organization: { id: "org-a" }
      },
      room: { id: "room-a" },
      meeting: { id: "meeting-a" },
      canonicalProfile: {
        id: "profile-owner",
        speakerProfileId: "profile-owner",
        createdBy: "user-owner",
        userId: "user-owner",
        name: "Owner",
        displayName: "Owner",
        profiles: [new Float32Array([1, 0])]
      },
      meetingStore: {
        async appendAcceptedSegment(_meetingId, _organizationId, segment) {
          const accepted = { ...segment, sequence: persisted.length };
          persisted.push(accepted);
          return accepted;
        }
      },
      async prepareSpeakerModel() {
        return {
          async compare() {
            return [0.95];
          }
        };
      },
      speakerModelInfo: {
        sampleRate: 16_000,
        defaultMatchThreshold: 0.72,
        defaultMatchMargin: 0.04
      },
      speakerInferenceInfo: {
        windowSeconds: 1,
        realtimeMaximumEmbeddings: 3
      },
      deepgramApiKey: "test-only-placeholder",
      hubConnection: {
        async acceptFinalSegment(segment, persist) {
          const accepted = await persist(segment);
          if (!accepted) return null;
          liveMap.push(accepted);
          client.send(JSON.stringify({ type: "accepted", segment: accepted }));
          client.send(JSON.stringify({ type: "transcript", segments: [accepted] }));
          return accepted;
        },
        async release() {}
      },
      createProvider() {
        return provider;
      }
    });

    provider.emit("open");
    client.emit("message", voicedPcm(16_000, 4), true);
    const result = JSON.stringify({
      type: "Results",
      is_final: true,
      from_finalize: true,
      metadata: { request_id: "accepted-final" },
      channel: {
        alternatives: [{
          words: [{
            speaker: 0,
            word: acceptedPhrase,
            start: 0,
            end: 4,
            confidence: 0.99
          }]
        }]
      }
    });
    provider.emit("message", result);
    provider.emit("message", result);
    client.emit("message", JSON.stringify({ type: "finalize", meetingId: "meeting-a" }), false);
    provider.emit("message", JSON.stringify({ type: "Results", from_finalize: true }));

    await waitForMessage(client, "finalized");

    assert.equal(persisted.length, 1);
    assert.equal(liveMap.length, 1);
    assert.deepEqual(persisted[0], {
      userId: "user-owner",
      speakerProfileId: "profile-owner",
      displayName: "Owner",
      speaker: "Owner",
      known: true,
      sourceSpeaker: "0",
      text: acceptedPhrase,
      start: 0,
      end: 4,
      confidence: 0.95,
      transcriptConfidence: 0.99,
      sequence: 0
    });
    const output = client.sent.map((value) => JSON.parse(String(value)));
    assert.equal(output.filter(({ type }) => type === "accepted").length, 1);
    assert.equal(output.filter(({ type }) => type === "transcript").length, 1);
  } finally {
    client.close();
    if (provider.readyState !== WebSocket.CLOSED) provider.close();
  }
});

test("disabled recognition keeps room STT running without loading the speaker model", async () => {
  const client = new FakeSocket();
  const provider = new FakeSocket();
  const persisted = [];
  let providerUrl = "";

  try {
    await handleSelfOnlyRoomLive({
      client,
      requestUrl: new URL("http://localhost/api/live?roomId=room-a"),
      auth: { user: { id: "user-owner", name: "Owner" }, organization: { id: "org-a" } },
      room: { id: "room-a" },
      meeting: { id: "meeting-a" },
      canonicalProfile: {
        id: "profile-owner", speakerProfileId: "profile-owner", createdBy: "user-owner",
        userId: "user-owner", name: "Owner", displayName: "Owner", profiles: []
      },
      meetingStore: {
        async appendAcceptedSegment(_meetingId, _organizationId, segment) {
          const accepted = { ...segment, sequence: persisted.length };
          persisted.push(accepted);
          return accepted;
        }
      },
      async prepareSpeakerModel() {
        assert.fail("speaker model must stay disabled");
      },
      speakerRecognitionEnabled: false,
      speakerModelInfo: { sampleRate: 16_000, defaultMatchThreshold: 0.72, defaultMatchMargin: 0.04 },
      speakerInferenceInfo: { windowSeconds: 1, realtimeMaximumEmbeddings: 3 },
      deepgramApiKey: "test-only-placeholder",
      hubConnection: {
        async acceptFinalSegment(segment, persist) { return persist(segment); },
        async release() {}
      },
      createProvider(url) {
        providerUrl = url;
        return provider;
      }
    });

    provider.emit("open");
    provider.emit("message", JSON.stringify({
      type: "Results",
      is_final: true,
      metadata: { request_id: "stt-final" },
      channel: {
        alternatives: [{
          words: [{ word: "모델 없이 받아쓰기", start: 0, end: 1, confidence: 0.98 }]
        }]
      }
    }));
    provider.emit("message", JSON.stringify({
      type: "Results",
      is_final: true,
      metadata: { request_id: "stt-final" },
      channel: {
        alternatives: [{
          words: [{ word: "모델 없이 받아쓰기", start: 0, end: 1, confidence: 0.98 }]
        }]
      }
    }));

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0], {
      speaker: "Owner",
      known: true,
      confidence: null,
      sourceSpeaker: null,
      start: 0,
      end: 1,
      text: "모델 없이 받아쓰기",
      transcriptConfidence: 0.98,
      userId: "user-owner",
      speakerProfileId: "profile-owner",
      displayName: "Owner",
      sequence: 0
    });
    assert.doesNotMatch(providerUrl, /diarize=true/);
  } finally {
    client.close();
    if (provider.readyState !== WebSocket.CLOSED) provider.close();
  }
});

test("finalize is stream-local, idempotent, and rejects later audio", async () => {
  const client = new FakeSocket();
  const provider = new FakeSocket();
  await handleSelfOnlyRoomLive({
    client,
    requestUrl: new URL("http://localhost/api/live?roomId=room-a"),
    auth: { user: { id: "user-owner", name: "Owner" }, organization: { id: "org-a" } },
    room: { id: "room-a" },
    meeting: { id: "meeting-a" },
    canonicalProfile: {
      id: "profile-owner", speakerProfileId: "profile-owner", createdBy: "user-owner",
      userId: "user-owner", name: "Owner", displayName: "Owner", profiles: [new Float32Array([1, 0])]
    },
    meetingStore: { async appendAcceptedSegment() { throw new Error("not expected"); } },
    async prepareSpeakerModel() { return { async compare() { return [0.95]; } }; },
    speakerModelInfo: { sampleRate: 16_000, defaultMatchThreshold: 0.72, defaultMatchMargin: 0.04 },
    speakerInferenceInfo: { windowSeconds: 1, realtimeMaximumEmbeddings: 3 },
    deepgramApiKey: "test-only-placeholder",
    hubConnection: { async acceptFinalSegment() {}, async release() {} },
    createProvider() { return provider; }
  });
  provider.emit("open");
  client.emit("message", JSON.stringify({ type: "finalize", meetingId: "meeting-a" }), false);
  client.emit("message", JSON.stringify({ type: "finalize", meetingId: "meeting-a" }), false);
  client.emit("message", voicedPcm(16_000, 1), true);
  provider.emit("message", JSON.stringify({ type: "Results", from_finalize: true }));
  await waitForMessage(client, "finalized");
  assert.equal(provider.sent.filter((value) => JSON.parse(String(value)).type === "Finalize").length, 1);
  assert.equal(client.sent.map(String).filter((value) => value.includes("ROOM_STREAM_FINALIZED")).length, 1);
  assert.equal(provider.sent.some((value) => Buffer.isBuffer(value)), false);
  assert.equal(client.sent.map(String).filter((value) => value.includes('"type":"finalized"')).length, 1);
  client.close();
});

test("rejected room phrase never reaches clients, persistence, LiveMap, or logs", async () => {
  const rejectedPhrase = "PRIVACY-CANARY-OTHER-SPEAKER";
  const client = new FakeSocket();
  const provider = new FakeSocket();
  const persisted = [];
  const liveMap = [];
  const capturedLogs = [];
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  console.error = (...values) => capturedLogs.push(values);
  console.log = (...values) => capturedLogs.push(values);

  try {
    await handleSelfOnlyRoomLive({
      client,
      requestUrl: new URL("http://localhost/api/live?roomId=room-a"),
      auth: {
        user: { id: "user-owner", name: "Owner" },
        organization: { id: "org-a" }
      },
      room: { id: "room-a" },
      meeting: { id: "meeting-a" },
      canonicalProfile: {
        id: "profile-owner",
        speakerProfileId: "profile-owner",
        createdBy: "user-owner",
        userId: "user-owner",
        name: "Owner",
        displayName: "Owner",
        profiles: [new Float32Array([1, 0])]
      },
      meetingStore: {
        async appendAcceptedSegment(_meetingId, _organizationId, segment) {
          persisted.push(segment);
          return { ...segment, sequence: persisted.length - 1 };
        }
      },
      async prepareSpeakerModel() {
        return {
          async compare() {
            return [0.1];
          }
        };
      },
      speakerModelInfo: {
        sampleRate: 16_000,
        defaultMatchThreshold: 0.72,
        defaultMatchMargin: 0.04
      },
      speakerInferenceInfo: {
        windowSeconds: 1,
        realtimeMaximumEmbeddings: 3
      },
      deepgramApiKey: "test-only-placeholder",
      hubConnection: {
        async acceptFinalSegment(segment, persist) {
          const accepted = await persist(segment);
          if (accepted) liveMap.push(accepted);
          return accepted;
        },
        async release() {}
      },
      createProvider() {
        return provider;
      }
    });

    provider.emit("open");
    client.emit("message", voicedPcm(16_000, 4), true);
    provider.emit("message", JSON.stringify({
      type: "Results",
      is_final: true,
      metadata: { request_id: "rejected-final" },
      channel: {
        alternatives: [{
          words: [{
            speaker: 0,
            word: rejectedPhrase,
            start: 0,
            end: 4,
            confidence: 0.99
          }]
        }]
      }
    }));
    client.emit("message", JSON.stringify({ type: "finalize", meetingId: "meeting-a" }), false);
    provider.emit("message", JSON.stringify({ type: "Results", from_finalize: true }));

    await waitForMessage(client, "finalized");

    assert.deepEqual(persisted, []);
    assert.deepEqual(liveMap, []);
    assert.doesNotMatch(JSON.stringify(client.sent), new RegExp(rejectedPhrase));
    assert.doesNotMatch(JSON.stringify(capturedLogs), new RegExp(rejectedPhrase));
  } finally {
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
    client.close();
    if (provider.readyState !== WebSocket.CLOSED) provider.close();
  }
});
