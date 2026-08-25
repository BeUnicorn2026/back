import assert from "node:assert/strict";
import test from "node:test";
import { recordingEnvelopeSimilarity, speakerProbeFingerprint, speakerVerificationUpdate } from "../lib/speaker-verification.mjs";

function patternedPcm(seconds = 6, sampleRate = 16_000) {
  const pcm = new Int16Array(seconds * sampleRate);
  for (let index = 0; index < pcm.length; index += 1) {
    const envelope = 0.2 + 0.7 * Math.abs(Math.sin(index / 7_913) * Math.cos(index / 3_277));
    pcm[index] = Math.round(Math.sin(index / 11.3) * envelope * 12_000);
  }
  return pcm;
}

test("detects the same recording after gain and codec-like quantization", () => {
  const original = patternedPcm();
  const transformed = Int16Array.from(original, (sample) => Math.round(sample * 0.72 / 32) * 32);
  const different = Int16Array.from(original, (_sample, index) =>
    Math.round(Math.sin(index / 17.7) * (0.2 + 0.7 * Math.abs(Math.sin(index / 1_931))) * 12_000));
  assert.ok(recordingEnvelopeSimilarity(original, transformed) > 0.99);
  assert.ok(recordingEnvelopeSimilarity(original, different) < 0.8);
  assert.equal(recordingEnvelopeSimilarity(original.subarray(0, 16_000), transformed), null);
});

test("fingerprints canonical PCM and records only an independent probe once", () => {
  const enrollment = new Int16Array([1, 2, 3, 4]);
  const probe = new Int16Array([5, 6, 7, 8]);
  const enrollmentFingerprint = speakerProbeFingerprint(enrollment, { sampleRate: 2, seconds: 1 });
  const probeFingerprint = speakerProbeFingerprint(probe, { sampleRate: 2, seconds: 1 });
  assert.notEqual(enrollmentFingerprint, probeFingerprint);

  const first = speakerVerificationUpdate({ enrollmentFingerprints: [enrollmentFingerprint] }, {
    fingerprint: probeFingerprint, score: 0.81, qualityScore: 88, verifiedAt: "2026-08-24T00:00:00.000Z",
    independentRecording: true, expectedSpeakerId: "speaker-a", predictedSpeakerId: "speaker-a"
  });
  assert.equal(first.recorded, true);
  assert.equal(first.attemptRecorded, true);
  assert.equal(first.changes.crossSessionVerificationCount, 1);
  assert.equal(first.changes.verificationAttemptCount, 1);
  assert.equal(first.changes.averageVerificationScore, 0.81);

  const duplicate = speakerVerificationUpdate({
    enrollmentFingerprints: [enrollmentFingerprint],
    verificationFingerprints: first.changes.verificationFingerprints,
    crossSessionVerificationCount: 1
  }, { fingerprint: probeFingerprint, score: 0.9, independentRecording: true, expectedSpeakerId: "speaker-a", predictedSpeakerId: "speaker-a" });
  assert.equal(duplicate.recorded, false);
  assert.equal(duplicate.reason, "duplicate_probe");
});

test("does not treat enrollment audio or legacy profiles as independent verification", () => {
  const fingerprint = speakerProbeFingerprint(new Int16Array([1, 2, 3]));
  assert.equal(speakerVerificationUpdate({ enrollmentFingerprints: [fingerprint] }, { fingerprint }).reason, "not_confirmed");
  const identity = { independentRecording: true, expectedSpeakerId: "speaker-a", predictedSpeakerId: "speaker-a" };
  assert.equal(speakerVerificationUpdate({ enrollmentFingerprints: [fingerprint] }, { fingerprint, ...identity }).reason, "enrollment_audio");
  assert.equal(speakerVerificationUpdate({ enrollmentFingerprints: [fingerprint] }, {
    fingerprint: "recoded", enrollmentAudioSimilarity: 0.998, ...identity
  }).reason, "enrollment_audio");
  assert.equal(speakerVerificationUpdate({}, { fingerprint, ...identity }).reason, "needs_new_enrollment");
});

test("requires the declared speaker to match the model decision", () => {
  const speaker = { enrollmentFingerprints: ["enrollment"] };
  const evidence = { fingerprint: "probe", independentRecording: true };
  assert.equal(speakerVerificationUpdate({}, evidence).reason, "expected_not_selected");
  const rejected = speakerVerificationUpdate(speaker, { ...evidence, expectedSpeakerId: "speaker-a" });
  assert.equal(rejected.reason, "expected_not_matched");
  assert.equal(rejected.attemptRecorded, true);
  assert.equal(rejected.changes.verificationFailureCount, 1);
  const wrong = speakerVerificationUpdate(speaker, {
    ...evidence, expectedSpeakerId: "speaker-a", predictedSpeakerId: "speaker-b"
  });
  assert.equal(wrong.reason, "unexpected_identity");
  assert.equal(wrong.changes.lastVerificationOutcome, "misidentified");
});
