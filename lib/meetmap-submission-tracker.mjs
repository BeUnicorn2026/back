import { createHash } from "node:crypto";
import { mergeMeetMapIntelligence } from "./go-meetmap-client.mjs";
import { transcriptHash } from "./meeting-intelligence.mjs";

const terminalStatuses = new Set(["succeeded", "failed"]);

// Mirror Go strings.TrimSpace: strip leading/trailing Unicode whitespace so the
// Node-side fingerprint matches how NormalizeSegments canonicalizes segment text.
function goTrimSpace(value) {
  return String(value ?? "").replace(/^\s+|\s+$/gu, "");
}

function goFloat(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// Mirror internal/meetmap NormalizeSegments: drop blank-text segments, trim
// text/speaker, default a blank speaker to "화자", and clamp start/end. This is
// the exact set of segments the Go analyzer counts, so its length is the
// authoritative "analyzedSegmentCount" for a submission.
export function normalizeMeetMapSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const normalized = [];
  for (const segment of segments) {
    const text = goTrimSpace(segment?.text);
    if (!text) continue;
    const start = Math.max(0, goFloat(segment?.start));
    normalized.push({
      speaker: goTrimSpace(segment?.speaker) || "화자",
      start,
      end: Math.max(start, goFloat(segment?.end)),
      text
    });
  }
  return normalized;
}

export function meetMapTranscriptFingerprint(segments) {
  const normalized = normalizeMeetMapSegments(segments);
  return createHash("sha256")
    .update("meetmap-submission-v1\0")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

// Bounded, TTL-pruned record of what transcript each MeetMap job was submitted
// with, keyed by the Go-returned job id. Persistence of a succeeded GET is gated
// on the current meeting still matching this submission-time fingerprint, so a
// transcript edit between submit and completion never persists a stale MeetMap.
export class MeetMapSubmissionTracker {
  #entries = new Map();

  constructor({ ttlMs = 30 * 60_000, maximumEntries = 2_000, now = Date.now } = {}) {
    this.ttlMs = Math.max(1_000, Number(ttlMs) || 30 * 60_000);
    this.maximumEntries = Math.max(1, Number(maximumEntries) || 2_000);
    this.now = now;
  }

  get size() {
    return this.#entries.size;
  }

  track(jobId, { meetingId, organizationId, tenantKey, segments }) {
    const id = String(jobId || "");
    if (!/^map_[a-f0-9]{32}$/.test(id)) return null;
    const normalized = normalizeMeetMapSegments(segments);
    const createdAt = this.now();
    this.#prune(createdAt);
    // Insertion-ordered eviction bounds memory even if TTL pruning has nothing
    // to reclaim (e.g. a burst of submissions inside the TTL window).
    while (this.#entries.size >= this.maximumEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const submission = Object.freeze({
      meetingId: String(meetingId || ""),
      organizationId: String(organizationId || ""),
      tenantKey: String(tenantKey || ""),
      fingerprint: meetMapTranscriptFingerprint(normalized),
      analyzedSegmentCount: normalized.length,
      expiresAt: createdAt + this.ttlMs
    });
    this.#entries.set(id, submission);
    return submission;
  }

  peek(jobId) {
    this.#prune(this.now());
    return this.#entries.get(String(jobId || "")) || null;
  }

  // Terminal jobs (succeeded/failed) are consumed once: return the tracked
  // submission and remove it so completed jobs never leak.
  takeTerminal(jobId, status) {
    this.#prune(this.now());
    if (!terminalStatuses.has(status)) return null;
    const id = String(jobId || "");
    const submission = this.#entries.get(id) || null;
    this.#entries.delete(id);
    return submission;
  }

  #prune(now) {
    for (const [jobId, submission] of this.#entries) {
      if (submission.expiresAt > now) continue;
      this.#entries.delete(jobId);
    }
  }
}

// Gate MeetMap persistence on the submission fingerprint. Returns true only when
// a succeeded job's tenant, meeting, normalized submitted-segment count, and the
// current persisted transcript all match the submission recorded at POST time.
export async function persistSucceededMeetMapJob({ job, submission, organizationId, meetingStore }) {
  if (job?.status !== "succeeded" || !job.meetingId || !job.result || !submission) return false;
  if (submission.organizationId !== String(organizationId || "")) return false;
  if (submission.meetingId !== job.meetingId) return false;
  // analyzedSegmentCount is the count of normalized SUBMITTED segments (blank
  // text dropped), not the number of nodes the analyzer chose to keep.
  if (job.result.analyzedSegmentCount !== submission.analyzedSegmentCount) return false;

  const meeting = await meetingStore.get(job.meetingId, organizationId);
  if (!meeting) return false;
  if (meetMapTranscriptFingerprint(meeting.segments) !== submission.fingerprint) return false;

  const hash = transcriptHash(meeting.segments);
  const existing = await meetingStore.getIntelligence(meeting.id, organizationId, hash);
  await meetingStore.saveIntelligence({
    meetingId: meeting.id,
    organizationId,
    transcriptHash: hash,
    source: job.result.source,
    model: job.result.model,
    result: mergeMeetMapIntelligence(existing, meeting, job.result)
  });
  return true;
}
