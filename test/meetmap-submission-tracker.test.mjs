import assert from "node:assert/strict";
import test from "node:test";
import { transcriptHash } from "../lib/meeting-intelligence.mjs";
import {
  MeetMapSubmissionTracker,
  meetMapTranscriptFingerprint,
  normalizeMeetMapSegments,
  persistSucceededMeetMapJob
} from "../lib/meetmap-submission-tracker.mjs";

const organizationId = "org-1";
const tenantKey = "org-1:user-1";
const jobId = "map_1234567890abcdef1234567890abcdef";

function segment(text, extra = {}) {
  return { speaker: "민수", start: 0, end: 1, text, ...extra };
}

// Minimal no-network meeting store double: only get()/getIntelligence()/saveIntelligence().
function fakeMeetingStore(meeting) {
  const saves = [];
  return {
    saves,
    async get(id, org) {
      return meeting && meeting.id === id && meeting.organizationId === org ? meeting : null;
    },
    async getIntelligence() {
      return null;
    },
    async saveIntelligence(entry) {
      saves.push(entry);
      return entry;
    }
  };
}

function succeededJob(analyzedSegmentCount, topics = [{ id: "topic-1", label: "안건", nodes: [] }]) {
  return {
    id: jobId,
    status: "succeeded",
    meetingId: "meeting-1",
    result: { topics, source: "openrouter", model: "stealth/ox-alpha", analyzedSegmentCount }
  };
}

test("normalizeMeetMapSegments drops blank-text segments and mirrors Go canonicalization", () => {
  const normalized = normalizeMeetMapSegments([
    segment("  안건 정리  "),
    segment("   "),
    segment("", { text: "\t\n" }),
    { speaker: "  ", start: -5, end: -1, text: "결정" }
  ]);
  assert.equal(normalized.length, 2);
  assert.deepEqual(normalized[0], { speaker: "민수", start: 0, end: 1, text: "안건 정리" });
  assert.deepEqual(normalized[1], { speaker: "화자", start: 0, end: 0, text: "결정" });
});

test("unchanged transcript persists even when result topic nodes omit some submitted segments", async () => {
  const submittedSegments = [segment("안건을 정합니다."), segment("다음 안건입니다."), segment("마무리하겠습니다.")];
  const normalized = normalizeMeetMapSegments(submittedSegments);
  const meeting = {
    id: "meeting-1",
    organizationId,
    // The persisted meeting is byte-for-byte the submitted transcript.
    segments: normalized.map((value) => ({ ...value }))
  };
  const store = fakeMeetingStore(meeting);
  const tracker = new MeetMapSubmissionTracker();
  const submission = tracker.track(jobId, {
    meetingId: "meeting-1",
    organizationId,
    tenantKey,
    segments: submittedSegments
  });
  assert.equal(submission.analyzedSegmentCount, 3);

  // Result keeps only ONE node out of three submitted segments — node count is
  // not the submitted-segment count, so persistence must still succeed.
  const job = succeededJob(3, [{ id: "topic-1", label: "안건", nodes: [{ id: "t1-n1", segmentIndex: 0, kind: "position", summary: "안건", parentId: "", relation: "" }] }]);
  const consumed = tracker.takeTerminal(jobId, job.status);
  assert.equal(consumed, submission);
  const persisted = await persistSucceededMeetMapJob({ job, submission: consumed, organizationId, meetingStore: store });

  assert.equal(persisted, true);
  assert.equal(store.saves.length, 1);
  assert.equal(store.saves[0].transcriptHash, transcriptHash(meeting.segments));
  assert.equal(store.saves[0].result.meetMap, job.result);
  // Terminal job consumed — no leak.
  assert.equal(tracker.size, 0);
});

test("same-length transcript content change does not persist", async () => {
  const submittedSegments = [segment("첫 번째 안건입니다."), segment("두 번째 안건입니다.")];
  // Persisted meeting edited AFTER submission: same segment count, changed text.
  const editedMeeting = {
    id: "meeting-1",
    organizationId,
    segments: normalizeMeetMapSegments(submittedSegments).map((value, index) =>
      index === 1 ? { ...value, text: "두 번째 안건을 바꿨습니다." } : { ...value })
  };
  const store = fakeMeetingStore(editedMeeting);
  const tracker = new MeetMapSubmissionTracker();
  const submission = tracker.track(jobId, {
    meetingId: "meeting-1",
    organizationId,
    tenantKey,
    segments: submittedSegments
  });

  // analyzedSegmentCount still equals the submitted count (2), so a naive
  // length check would pass — only the fingerprint catches the edit.
  assert.equal(submission.analyzedSegmentCount, editedMeeting.segments.length);
  assert.notEqual(meetMapTranscriptFingerprint(editedMeeting.segments), submission.fingerprint);

  const job = succeededJob(2);
  const persisted = await persistSucceededMeetMapJob({
    job,
    submission: tracker.takeTerminal(jobId, job.status),
    organizationId,
    meetingStore: store
  });

  assert.equal(persisted, false);
  assert.equal(store.saves.length, 0);
});

test("tracker consumes terminal jobs and bounds memory by capacity", () => {
  const tracker = new MeetMapSubmissionTracker({ maximumEntries: 2 });
  const ids = Array.from({ length: 3 }, (_value, index) =>
    `map_${String(index).padStart(32, "0").replace(/[^a-f0-9]/g, "a")}`);
  for (const id of ids) tracker.track(id, { meetingId: "meeting-1", organizationId, tenantKey, segments: [segment("안건")] });
  assert.equal(tracker.size, 2);
  // Oldest evicted.
  assert.equal(tracker.peek(ids[0]), null);
  assert.notEqual(tracker.peek(ids[2]), null);

  // Non-terminal status returns nothing and leaves the entry in place.
  assert.equal(tracker.takeTerminal(ids[2], "running"), null);
  assert.notEqual(tracker.peek(ids[2]), null);
  // Terminal failed status removes it.
  assert.notEqual(tracker.takeTerminal(ids[2], "failed"), null);
  assert.equal(tracker.peek(ids[2]), null);
});

test("expired submissions are pruned by TTL", () => {
  let clock = 1_000;
  const tracker = new MeetMapSubmissionTracker({ ttlMs: 5_000, now: () => clock });
  tracker.track(jobId, { meetingId: "meeting-1", organizationId, tenantKey, segments: [segment("안건")] });
  assert.equal(tracker.size, 1);
  clock += 6_000;
  assert.equal(tracker.peek(jobId), null);
  assert.equal(tracker.size, 0);
});
