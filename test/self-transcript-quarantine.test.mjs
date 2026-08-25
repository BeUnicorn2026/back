import test from "node:test";
import assert from "node:assert/strict";
import { createSelfTranscriptQuarantine } from "../lib/self-transcript-quarantine.mjs";

const canonical = {
  id: "profile-owner",
  name: "소유자",
  createdBy: "user-owner"
};

const accepted = {
  accepted: true,
  reason: "accepted",
  bestScore: 0.93,
  identity: {
    id: "profile-owner",
    speakerProfileId: "profile-owner",
    createdBy: "user-owner",
    userId: "user-owner",
    name: "소유자",
    score: 0.93
  }
};

const providerFinal = (id, speaker, text, start = 0, confidence = 0.8) => ({
  providerFinalId: id,
  receivedAt: 1_000,
  words: [{ speaker, word: text, start, end: start + 0.5, confidence }]
});

const flattenText = (outputs) => outputs.map(({ text }) => text).join(" ");

test("quarantines unknown, ambiguous, below-threshold, other, and unlabeled transcript text", () => {
  const attempts = [
    { name: "unknown", decision: { accepted: false, reason: "invalid_scores" } },
    { name: "ambiguous", decision: { accepted: false, reason: "ambiguous" } },
    { name: "below", decision: { accepted: false, reason: "below_threshold" } },
    {
      name: "other",
      decision: {
        accepted: true,
        bestScore: 0.99,
        identity: { id: "other-profile", createdBy: "other-user", name: "다른 사람" }
      }
    }
  ];

  for (const [index, attempt] of attempts.entries()) {
    const quarantine = createSelfTranscriptQuarantine(canonical);
    const phrase = `SECRET-${attempt.name}`;
    assert.deepEqual(quarantine.ingestFinal(providerFinal(`f-${index}`, index, phrase)), []);
    assert.deepEqual(quarantine.updateDecision(index, attempt.decision, 1_001), []);
    assert.doesNotMatch(flattenText(quarantine.updateDecision(index, accepted, 1_002)), /SECRET/);
  }

  const unlabeled = createSelfTranscriptQuarantine(canonical);
  assert.deepEqual(unlabeled.ingestFinal({
    providerFinalId: "unlabeled",
    receivedAt: 1_000,
    words: [{ word: "SECRET-unlabeled", start: 0, end: 1 }]
  }), []);
  assert.deepEqual(unlabeled.updateDecision("0", accepted, 1_001), []);
});

test("releases accepted identity as canonical authority and never trusts provider labels", () => {
  const quarantine = createSelfTranscriptQuarantine(canonical);
  assert.deepEqual(quarantine.ingestFinal({
    providerFinalId: "authority",
    receivedAt: 1_000,
    words: [
      { speaker: 7, word: "본인", start: 2, end: 2.3, confidence: 0.7 },
      { speaker: 7, punctuated_word: "발화.", start: 2.4, end: 3, confidence: 0.9 }
    ]
  }), []);

  assert.deepEqual(quarantine.updateDecision("7", accepted, 1_001), [{
    userId: "user-owner",
    speakerProfileId: "profile-owner",
    displayName: "소유자",
    speaker: "소유자",
    known: true,
    sourceSpeaker: "7",
    text: "본인 발화.",
    start: 2,
    end: 3,
    confidence: 0.93,
    transcriptConfidence: 0.8
  }]);
});

test("deduplicates provider finals and requires fresh evidence for later finals", () => {
  const quarantine = createSelfTranscriptQuarantine(canonical);
  const first = providerFinal("same-final", 0, "한번만");
  assert.deepEqual(quarantine.ingestFinal(first), []);
  assert.deepEqual(quarantine.ingestFinal(first), []);
  assert.equal(quarantine.updateDecision(0, accepted, 1_001).length, 1);
  assert.deepEqual(quarantine.updateDecision(0, accepted, 1_002), []);
  assert.deepEqual(quarantine.ingestFinal(first), []);

  const later = quarantine.ingestFinal(providerFinal("later", 0, "재검증", 4));
  assert.deepEqual(later, []);
  assert.deepEqual(quarantine.updateDecision(0, accepted, 1_003).map(({ text }) => text), ["재검증"]);
});

test("isolates clusters and releases each accepted queue chronologically", () => {
  const quarantine = createSelfTranscriptQuarantine(canonical);
  quarantine.ingestFinal(providerFinal("late", "owner-cluster", "두번째", 8));
  quarantine.ingestFinal(providerFinal("other", "other-cluster", "SECRET-other", 3));
  quarantine.ingestFinal(providerFinal("early", "owner-cluster", "첫번째", 1));

  const released = quarantine.updateDecision("owner-cluster", accepted, 1_001);
  assert.deepEqual(released.map(({ text }) => text), ["첫번째", "두번째"]);
  assert.doesNotMatch(flattenText(released), /SECRET/);
  assert.deepEqual(quarantine.updateDecision("other-cluster", {
    accepted: true,
    identity: { id: "other", createdBy: "other", name: "타인" }
  }, 1_002), []);
});

test("interims never enter quarantine or release", () => {
  const quarantine = createSelfTranscriptQuarantine(canonical);
  assert.deepEqual(quarantine.ingestFinal({
    isFinal: false,
    providerFinalId: "interim",
    words: [{ speaker: 0, word: "SECRET-interim", start: 0, end: 1 }]
  }), []);
  assert.deepEqual(quarantine.updateDecision(0, accepted), []);
});

test("accepted identity evidence expires and a reused label requires fresh evidence", () => {
  const quarantine = createSelfTranscriptQuarantine(canonical, { maxAgeMs: 10 });
  quarantine.ingestFinal(providerFinal("accepted", 0, "첫 발화"));
  assert.deepEqual(quarantine.updateDecision(0, accepted, 1_001).map(({ text }) => text), ["첫 발화"]);
  quarantine.expire(1_011);
  assert.deepEqual(quarantine.ingestFinal({ ...providerFinal("reused", 0, "재사용 라벨", 4), receivedAt: 1_012 }), []);
  assert.deepEqual(quarantine.updateDecision(0, accepted, 1_013).map(({ text }) => text), ["재사용 라벨"]);
});

test("expired phrases are discarded and never recoverable", () => {
  const quarantine = createSelfTranscriptQuarantine(canonical, { maxAgeMs: 10 });
  quarantine.ingestFinal(providerFinal("expired", 0, "SECRET-expired"));
  assert.equal(quarantine.expire(1_010), 1);
  assert.deepEqual(quarantine.updateDecision(0, accepted, 1_011), []);
  assert.equal(quarantine.stats().queuedTextBytes, 0);
});

test("provider final dedupe never re-emits an old id after count pressure within its age window", () => {
  const quarantine = createSelfTranscriptQuarantine(canonical, { maxSeenFinals: 2, maxAgeMs: 100 });
  const first = providerFinal("one", 0, "first");
  quarantine.ingestFinal(first);
  quarantine.ingestFinal(providerFinal("two", 1, "second"));
  quarantine.ingestFinal(providerFinal("overflow", 2, "SECRET-overflow"));
  assert.deepEqual(quarantine.ingestFinal(first), []);
  assert.deepEqual(quarantine.updateDecision(0, accepted, 1_001).map(({ text }) => text), ["first"]);
  assert.deepEqual(quarantine.updateDecision(2, accepted, 1_001), []);
});

test("cluster, utterance, text, and deduplication bounds discard overflow without text outputs", () => {
  const quarantine = createSelfTranscriptQuarantine(canonical, {
    maxClusters: 2,
    maxQueuedUtterances: 2,
    maxQueuedUtterancesPerCluster: 1,
    maxTextBytes: 12,
    maxSeenFinals: 2
  });
  const outputs = [
    quarantine.ingestFinal(providerFinal("one", 0, "first")),
    quarantine.ingestFinal(providerFinal("per-cluster-overflow", 0, "SECRET-per-cluster")),
    quarantine.ingestFinal(providerFinal("two", 1, "second")),
    quarantine.ingestFinal(providerFinal("cluster-overflow", 2, "SECRET-cluster")),
    quarantine.ingestFinal(providerFinal("total-overflow", 1, "SECRET-total"))
  ].flat();

  assert.deepEqual(outputs, []);
  assert.deepEqual(quarantine.stats(), {
    clusters: 2,
    queuedUtterances: 2,
    queuedTextBytes: 11,
    seenFinals: 2,
    closed: false
  });
  const released = [
    ...quarantine.updateDecision(0, accepted, 1_001),
    ...quarantine.updateDecision(1, accepted, 1_001)
  ];
  assert.deepEqual(released.map(({ text }) => text), ["first", "second"]);
  assert.doesNotMatch(flattenText(released), /SECRET/);
});

test("wipe, discard, and close erase queued text without returning it", () => {
  const quarantine = createSelfTranscriptQuarantine(canonical);
  quarantine.ingestFinal(providerFinal("discard", 0, "SECRET-discard"));
  assert.equal(quarantine.discard(0), 1);
  assert.deepEqual(quarantine.updateDecision(0, accepted, 1_001), []);

  quarantine.ingestFinal(providerFinal("wipe", 1, "SECRET-wipe"));
  assert.equal(quarantine.wipe(), 1);
  assert.deepEqual(quarantine.updateDecision(1, accepted, 1_001), []);

  quarantine.ingestFinal(providerFinal("close", 2, "SECRET-close"));
  assert.equal(quarantine.close(), 1);
  assert.deepEqual(quarantine.ingestFinal(providerFinal("after-close", 2, "SECRET-after")), []);
  assert.deepEqual(quarantine.updateDecision(2, accepted), []);
  assert.deepEqual(quarantine.stats(), {
    clusters: 0,
    queuedUtterances: 0,
    queuedTextBytes: 0,
    seenFinals: 0,
    closed: true
  });
});

test("raw evidence uses open-set threshold and releases only accepted canonical evidence", () => {
  const low = createSelfTranscriptQuarantine(canonical);
  low.ingestFinal(providerFinal("low", 0, "SECRET-low"));
  assert.deepEqual(low.updateEvidence(0, 0.6, { threshold: 0.8, now: 1_001 }), []);
  assert.deepEqual(low.updateEvidence(0, 0.95, { threshold: 0.8, now: 1_002 }), []);

  const high = createSelfTranscriptQuarantine(canonical);
  high.ingestFinal(providerFinal("high", 0, "허용"));
  assert.deepEqual(high.updateEvidence(0, 0.95, { threshold: 0.8, now: 1_001 }).map(({ text }) => text), ["허용"]);
});
