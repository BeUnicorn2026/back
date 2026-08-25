import { speakerDecision } from "./speaker-matching.mjs";

const DEFAULT_LIMITS = Object.freeze({
  maxClusters: 16,
  maxQueuedUtterances: 128,
  maxQueuedUtterancesPerCluster: 32,
  maxTextBytes: 64 * 1024,
  maxAgeMs: 30_000,
  maxSeenFinals: 512
});

function boundedInteger(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
}

function clusterKey(value) {
  if (value == null || value === "") return null;
  const key = String(value);
  return key.length <= 128 ? key : null;
}

function wordText(word) {
  return String(word?.punctuated_word ?? word?.word ?? "").trim();
}

function appendWord(text, word) {
  if (!text) return word;
  return /^[,.!?;:)]/.test(word) ? `${text}${word}` : `${text} ${word}`;
}

function normalizedIdentity(profile) {
  const speakerProfileId = profile?.speakerProfileId ?? profile?.id;
  const userId = profile?.userId ?? profile?.createdBy;
  const displayName = profile?.displayName ?? profile?.name;
  if (speakerProfileId == null || userId == null || !displayName) {
    throw new TypeError("canonicalProfile requires profile id, owner user id, and display name");
  }
  return Object.freeze({
    userId: String(userId),
    speakerProfileId: String(speakerProfileId),
    displayName: String(displayName)
  });
}

function decisionIdentity(decision) {
  return decision?.identity ?? decision?.speaker ?? null;
}

function identityMatchesCanonical(identity, canonical) {
  if (!identity) return false;
  const profileId = identity.speakerProfileId ?? identity.id;
  const userId = identity.userId ?? identity.createdBy;
  return String(profileId ?? "") === canonical.speakerProfileId
    && String(userId ?? "") === canonical.userId;
}

function finalRuns(input) {
  const words = Array.isArray(input?.words) ? input.words : [];
  const fallbackCluster = clusterKey(input?.sourceSpeaker);
  const runs = [];

  for (const word of words) {
    const text = wordText(word);
    if (!text) continue;
    const sourceSpeaker = clusterKey(word?.speaker ?? word?.sourceSpeaker ?? fallbackCluster);
    if (sourceSpeaker == null) continue;
    const start = Math.max(0, Number(word?.start) || 0);
    const end = Math.max(start, Number(word?.end) || start);
    const transcriptConfidence = Number(word?.confidence);
    const previous = runs.at(-1);
    if (previous?.sourceSpeaker === sourceSpeaker) {
      previous.text = appendWord(previous.text, text);
      previous.end = Math.max(previous.end, end);
      if (Number.isFinite(transcriptConfidence)) {
        previous.confidenceTotal += transcriptConfidence;
        previous.confidenceCount += 1;
      }
      continue;
    }
    runs.push({
      sourceSpeaker,
      start,
      end,
      text,
      confidenceTotal: Number.isFinite(transcriptConfidence) ? transcriptConfidence : 0,
      confidenceCount: Number.isFinite(transcriptConfidence) ? 1 : 0
    });
  }
  return runs;
}

function fallbackFinalKey(providerFinalId, run) {
  if (providerFinalId != null && providerFinalId !== "") {
    return `id:${String(providerFinalId)}:${run.sourceSpeaker}:${run.start}:${run.end}`;
  }
  return `words:${run.sourceSpeaker}:${run.start}:${run.end}:${run.text}`;
}

/**
 * Holds finalized transcript text until its diarization cluster is independently
 * verified as the session owner's one canonical speaker profile.
 */
export class SelfTranscriptQuarantine {
  constructor(canonicalProfile, options = {}) {
    this.identity = normalizedIdentity(canonicalProfile);
    this.profile = Object.freeze({ ...canonicalProfile });
    this.limits = Object.freeze({
      maxClusters: boundedInteger(options.maxClusters, DEFAULT_LIMITS.maxClusters),
      maxQueuedUtterances: boundedInteger(options.maxQueuedUtterances, DEFAULT_LIMITS.maxQueuedUtterances),
      maxQueuedUtterancesPerCluster: boundedInteger(
        options.maxQueuedUtterancesPerCluster,
        DEFAULT_LIMITS.maxQueuedUtterancesPerCluster
      ),
      maxTextBytes: boundedInteger(options.maxTextBytes, DEFAULT_LIMITS.maxTextBytes),
      maxAgeMs: boundedInteger(options.maxAgeMs, DEFAULT_LIMITS.maxAgeMs),
      maxSeenFinals: boundedInteger(options.maxSeenFinals, DEFAULT_LIMITS.maxSeenFinals)
    });
    this.clusters = new Map();
    this.seenFinals = new Map();
    this.queuedUtterances = 0;
    this.queuedTextBytes = 0;
    this.sequence = 0;
    this.closed = false;
  }

  ingestFinal(input = {}) {
    if (this.closed || input?.isFinal === false) return [];
    const now = Number.isFinite(Number(input.receivedAt)) ? Number(input.receivedAt) : Date.now();
    this.expire(now);
    const releases = [];

    for (const run of finalRuns(input)) {
      const finalKey = fallbackFinalKey(input.providerFinalId ?? input.id, run);
      if (this.seenFinals.has(finalKey)) continue;

      const cluster = this.getOrCreateCluster(run.sourceSpeaker, now);
      if (!cluster || cluster.status === "rejected") continue;
      const utterance = {
        ...run,
        transcriptConfidence: run.confidenceCount ? run.confidenceTotal / run.confidenceCount : null,
        receivedAt: now,
        sequence: this.sequence += 1,
        bytes: Buffer.byteLength(run.text, "utf8")
      };
      if (cluster.status === "accepted") {
        releases.push(this.releaseValue(utterance, cluster));
      } else if (this.enqueue(cluster, utterance)) {
        if (!this.rememberFinal(finalKey, now)) {
          cluster.queue.pop();
          this.removeQueued(utterance);
        }
      }
    }

    return releases.sort((left, right) => left.start - right.start || left.end - right.end);
  }

  updateEvidence(sourceSpeaker, scoreOrScores, options = {}) {
    const scores = Array.isArray(scoreOrScores) ? scoreOrScores : [scoreOrScores];
    const decision = speakerDecision(scores, [this.profile], options);
    return this.updateDecision(sourceSpeaker, decision, options.now);
  }

  updateDecision(sourceSpeaker, decision, now = Date.now()) {
    if (this.closed) return [];
    const time = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    this.expire(time);
    const key = clusterKey(sourceSpeaker);
    if (key == null) return [];
    const cluster = this.getOrCreateCluster(key, time);
    if (!cluster || cluster.status === "rejected") return [];
    cluster.touchedAt = time;

    if (!decision?.accepted || !identityMatchesCanonical(decisionIdentity(decision), this.identity)) {
      this.rejectCluster(key);
      return [];
    }

    cluster.status = "accepted";
    cluster.speakerConfidence = Number.isFinite(Number(decision.bestScore))
      ? Number(decision.bestScore)
      : Number.isFinite(Number(decision.identity?.score)) ? Number(decision.identity.score) : null;
    const queued = cluster.queue
      .splice(0)
      .sort((left, right) => left.start - right.start || left.sequence - right.sequence);
    for (const utterance of queued) this.removeQueued(utterance);
    const released = queued.map((utterance) => this.releaseValue(utterance, cluster));
    // A provider may reuse a diarization label for another speaker. Treat an
    // accepted decision as evidence for only the transcript already queued;
    // every later final using the same label must earn fresh identity evidence.
    this.clusters.delete(key);
    return released;
  }

  expire(now = Date.now()) {
    const time = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    let discarded = 0;
    for (const [finalKey, seenAt] of this.seenFinals) {
      if (time - seenAt >= this.limits.maxAgeMs) this.seenFinals.delete(finalKey);
    }
    for (const [key, cluster] of this.clusters) {
      const retained = [];
      for (const utterance of cluster.queue) {
        if (time - utterance.receivedAt >= this.limits.maxAgeMs) {
          this.removeQueued(utterance);
          discarded += 1;
        } else {
          retained.push(utterance);
        }
      }
      cluster.queue = retained;
      if (!cluster.queue.length && time - cluster.touchedAt >= this.limits.maxAgeMs) {
        this.clusters.delete(key);
      }
    }
    return discarded;
  }

  discard(sourceSpeaker) {
    const key = clusterKey(sourceSpeaker);
    if (key == null) return 0;
    const cluster = this.clusters.get(key);
    if (!cluster) return 0;
    const discarded = cluster.queue.length;
    for (const utterance of cluster.queue) this.removeQueued(utterance);
    this.clusters.delete(key);
    return discarded;
  }

  wipe() {
    const discarded = this.queuedUtterances;
    for (const cluster of this.clusters.values()) cluster.queue.length = 0;
    this.clusters.clear();
    this.seenFinals.clear();
    this.queuedUtterances = 0;
    this.queuedTextBytes = 0;
    return discarded;
  }

  close() {
    const discarded = this.wipe();
    this.closed = true;
    return discarded;
  }

  stats() {
    return Object.freeze({
      clusters: this.clusters.size,
      queuedUtterances: this.queuedUtterances,
      queuedTextBytes: this.queuedTextBytes,
      seenFinals: this.seenFinals.size,
      closed: this.closed
    });
  }

  getOrCreateCluster(key, now) {
    const existing = this.clusters.get(key);
    if (existing) return existing;
    if (this.clusters.size >= this.limits.maxClusters) return null;
    const cluster = { status: "pending", speakerConfidence: null, queue: [], touchedAt: now };
    this.clusters.set(key, cluster);
    return cluster;
  }

  rememberFinal(key, now) {
    // Never evict an unexpired provider id merely to satisfy a count cap: doing
    // so would let the provider replay that id and release old transcript text.
    // maxSeenFinals limits admission of new unique IDs until age expiry instead.
    if (this.seenFinals.size >= this.limits.maxSeenFinals) return false;
    this.seenFinals.set(key, now);
    return true;
  }

  enqueue(cluster, utterance) {
    if (cluster.queue.length >= this.limits.maxQueuedUtterancesPerCluster
      || this.queuedUtterances >= this.limits.maxQueuedUtterances
      || utterance.bytes > this.limits.maxTextBytes - this.queuedTextBytes) {
      return false;
    }
    cluster.queue.push(utterance);
    cluster.touchedAt = utterance.receivedAt;
    this.queuedUtterances += 1;
    this.queuedTextBytes += utterance.bytes;
    return true;
  }

  removeQueued(utterance) {
    this.queuedUtterances = Math.max(0, this.queuedUtterances - 1);
    this.queuedTextBytes = Math.max(0, this.queuedTextBytes - utterance.bytes);
  }

  rejectCluster(key) {
    const cluster = this.clusters.get(key);
    if (!cluster) return;
    for (const utterance of cluster.queue) this.removeQueued(utterance);
    cluster.queue.length = 0;
    cluster.status = "rejected";
    cluster.speakerConfidence = null;
  }

  releaseValue(utterance, cluster) {
    return Object.freeze({
      userId: this.identity.userId,
      speakerProfileId: this.identity.speakerProfileId,
      displayName: this.identity.displayName,
      speaker: this.identity.displayName,
      known: true,
      sourceSpeaker: utterance.sourceSpeaker,
      text: utterance.text,
      start: utterance.start,
      end: utterance.end,
      confidence: cluster.speakerConfidence,
      ...(utterance.transcriptConfidence == null
        ? {}
        : { transcriptConfidence: utterance.transcriptConfidence })
    });
  }
}

export function createSelfTranscriptQuarantine(canonicalProfile, options) {
  return new SelfTranscriptQuarantine(canonicalProfile, options);
}
