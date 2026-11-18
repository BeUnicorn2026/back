import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MeetingStore } from "../lib/meeting-store.mjs";
import { transcriptHash } from "../lib/meeting-intelligence.mjs";

test("persists and isolates organization meetings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-meetings-"));
  const store = new MeetingStore(root);
  const meeting = await store.create({ organizationId: "org-a", createdBy: "user-a", source: "live", language: "ko", mode: "stt" });
  assert.equal(meeting.mode, "stt");

  const updated = await store.update(meeting.id, "org-a", {
    status: "completed",
    duration: 3.4,
    segments: [{ speaker: "민수", known: true, corrected: true, transcriptCorrected: true, confidence: null, transcriptConfidence: 0.84, sourceSpeaker: "0", start: 0, end: 3.4, text: "실제 회의를 저장합니다." }]
  });

  assert.equal(updated.status, "completed");
  assert.equal(updated.title, "실제 회의를 저장합니다.");
  assert.equal(updated.speakerCount, 1);
  assert.equal(updated.segments[0].corrected, true);
  assert.equal(updated.segments[0].transcriptCorrected, true);
  assert.equal(updated.segments[0].confidence, null);
  assert.equal(updated.segments[0].transcriptConfidence, 0.84);
  const staleAutosave = await store.update(meeting.id, "org-a", {
    status: "recording",
    duration: 1,
    segments: [{ speaker: "민수", start: 0, end: 1, text: "오래된 자동 저장" }]
  });
  assert.equal(staleAutosave.status, "completed");
  assert.equal(staleAutosave.duration, 3.4);
  assert.equal(staleAutosave.segments[0].text, "실제 회의를 저장합니다.");
  assert.equal((await store.list("org-a")).length, 1);
  assert.equal((await store.list("org-b")).length, 0);
  assert.equal(await store.countSince("org-a", "2000-01-01T00:00:00.000Z"), 1);
  assert.equal(await store.countSince("org-a", "2999-01-01T00:00:00.000Z"), 0);
  assert.equal(await store.get(meeting.id, "org-b"), null);

  const hash = transcriptHash(updated.segments);
  const intelligence = await store.saveIntelligence({
    meetingId: meeting.id, organizationId: "org-a", transcriptHash: hash,
    source: "local", model: null, result: { title: "분석", topics: [], terms: [], actions: [] }
  });
  assert.equal(intelligence.source, "local");
  assert.equal((await store.getIntelligence(meeting.id, "org-a", hash)).title, "분석");
  assert.equal((await store.get(meeting.id, "org-a")).title, "분석");
  assert.equal(await store.getIntelligence(meeting.id, "org-b", hash), null);
  assert.equal(await store.getIntelligence(meeting.id, "org-a", "changed"), null);
  assert.equal(await store.remove(meeting.id, "org-b"), false);
  assert.equal(await store.remove(meeting.id, "org-a"), true);
  assert.equal(await store.get(meeting.id, "org-a"), null);
  assert.equal(await store.getIntelligence(meeting.id, "org-a", hash), null);
  assert.equal(await store.remove(meeting.id, "org-a"), false);
});

test("sanitizes meeting updates and preserves explicit titles", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-meetings-"));
  const store = new MeetingStore(root);
  const meeting = await store.create({ organizationId: "org", createdBy: "user", title: "제품 회의", source: "upload" });
  const updated = await store.update(meeting.id, "org", {
    title: "주간 제품 회의",
    status: "completed",
    segments: [{ start: -2, end: -1, text: "  결정 사항  ", speaker: "" }, { text: " " }]
  });

  assert.equal(updated.title, "주간 제품 회의");
  assert.equal(updated.segments.length, 1);
  assert.equal(updated.segments[0].start, 0);
  assert.equal(updated.segments[0].speaker, "미등록 화자");
});

test("reuses an active room meeting and appends accepted segments monotonically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-meetings-"));
  const store = new MeetingStore(root);
  const roomId = "00000000-0000-4000-8000-000000000001";
  const first = await store.create({ organizationId: "org", createdBy: "user", roomId });
  const replay = await store.create({ organizationId: "org", createdBy: "user", roomId, title: "ignored" });
  assert.equal(replay.id, first.id);
  const one = await store.appendAcceptedSegment(first.id, "org", {
    userId: "user", speakerProfileId: "profile", speaker: "민수", start: 0, end: 1, text: "첫 구간"
  });
  const two = await store.appendAcceptedSegment(first.id, "org", {
    userId: null, speakerProfileId: null, speaker: "미상", start: 1, end: 2, text: "둘째 구간"
  });
  assert.equal(one.sequence, 0);
  assert.equal(two.sequence, 1);
  const loaded = await store.get(first.id, "org");
  assert.equal(loaded.roomId, roomId);
  assert.deepEqual(loaded.segments.map(({ sequence }) => sequence), [0, 1]);
  assert.equal(loaded.segments[0].userId, "user");
  assert.equal(loaded.segments[0].speakerProfileId, "profile");

  const unsafeAutosave = await store.update(first.id, "org", {
    duration: 9,
    segments: [{ speaker: "공격자", start: 0, end: 9, text: "전체 대화 덮어쓰기" }]
  });
  assert.equal(unsafeAutosave.duration, 9);
  assert.deepEqual(unsafeAutosave.segments.map(({ text }) => text), ["첫 구간", "둘째 구간"]);
});

test("room close durably completes its active meeting and binding cannot race afterward", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-meetings-"));
  const databasePath = path.join(root, "shared.sqlite");
  const { RoomStore } = await import("../lib/room-store.mjs");
  const { AuthStore } = await import("../lib/auth-store.mjs");
  const authStore = new AuthStore(root, { databasePath, verificationSecret: "test-secret" });
  await authStore.initialize();
  const user = await authStore.signup({
    email: "owner@example.com", name: "Owner", password: "secure-pass", introduction: "Test owner"
  });
  const { organization } = await authStore.createOrganization(user.id, { name: "Org", domain: "example.com" });
  const roomStore = new RoomStore(root, {
    databasePath,
    uuidFactory: () => "00000000-0000-4000-8000-000000000001",
    roomFactory: () => "1234",
    accessCodeFactory: () => "VP-0123456789AB"
  });
  const meetingStore = new MeetingStore(root, { databasePath });
  await Promise.all([roomStore.initialize(), meetingStore.initialize()]);
  const room = await roomStore.create({
    organizationId: organization.id, createdBy: user.id, command: "ROOM", idempotencyKey: "close-test"
  });
  const meeting = await meetingStore.bindRoomMeeting({
    organizationId: organization.id, createdBy: user.id, roomId: room.id, title: room.room
  });
  await meetingStore.appendAcceptedSegment(meeting.id, organization.id, {
    speaker: "Owner", start: 1, end: 4.5, text: "persisted"
  });

  const closed = await roomStore.close(room.id, organization.id, user.id);
  const replay = await roomStore.close(room.id, organization.id, user.id);
  assert.equal(closed.status, "closed");
  assert.equal(replay.closedAt, closed.closedAt);
  const completed = await meetingStore.get(meeting.id, organization.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.duration, 4.5);
  assert.ok(completed.endedAt);
  assert.equal(await meetingStore.bindRoomMeeting({
    organizationId: organization.id, createdBy: user.id, roomId: room.id
  }), null);
});

test("creates a completed upload and its segments atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-meetings-"));
  const store = new MeetingStore(root);
  await assert.rejects(store.createCompleted({ organizationId: "org", createdBy: "user", segments: [] }),
    /대화 내용/);
  assert.equal((await store.list("org")).length, 0);

  const meeting = await store.createCompleted({
    organizationId: "org", createdBy: "user", language: "ko", title: "인터뷰.wav",
    importKey: "9aebfbe1-6436-4996-8ee5-46ff80ade67d",
    segments: [{ speaker: "민수", known: true, start: 1, end: 4.2, text: "파일 전사 결과입니다." }]
  });
  assert.equal(meeting.status, "completed");
  assert.equal(meeting.source, "upload");
  assert.equal(meeting.duration, 4.2);
  assert.equal(meeting.segmentCount, 1);
  assert.equal((await store.get(meeting.id, "org")).segments[0].text, "파일 전사 결과입니다.");
  const duplicate = await store.createCompleted({
    organizationId: "org", createdBy: "user", importKey: "9aebfbe1-6436-4996-8ee5-46ff80ade67d",
    segments: [{ text: "중복 전사는 저장하지 않습니다." }]
  });
  assert.equal(duplicate.id, meeting.id);
  assert.equal((await store.list("org")).length, 1);
  assert.equal((await store.getByImportKey("org", "9aebfbe1-6436-4996-8ee5-46ff80ade67d")).id, meeting.id);
  assert.equal(await store.getByImportKey("other-org", "9aebfbe1-6436-4996-8ee5-46ff80ade67d"), null);
});
