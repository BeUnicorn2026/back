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
  assert.equal((await store.list("org-a")).length, 1);
  assert.equal((await store.list("org-b")).length, 0);
  assert.equal(await store.get(meeting.id, "org-b"), null);

  const hash = transcriptHash(updated.segments);
  const intelligence = await store.saveIntelligence({
    meetingId: meeting.id, organizationId: "org-a", transcriptHash: hash,
    source: "local", model: null, result: { title: "분석", topics: [], terms: [], actions: [] }
  });
  assert.equal(intelligence.source, "local");
  assert.equal((await store.getIntelligence(meeting.id, "org-a", hash)).title, "분석");
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
