import assert from "node:assert/strict";
import test from "node:test";
import { speakerProbeFingerprint, speakerVerificationUpdate } from "../lib/speaker-verification.mjs";

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
  assert.equal(first.changes.crossSessionVerificationCount, 1);
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
  assert.equal(speakerVerificationUpdate({}, { fingerprint, ...identity }).reason, "needs_new_enrollment");
});

test("requires the declared speaker to match the model decision", () => {
  const evidence = { fingerprint: "probe", independentRecording: true };
  assert.equal(speakerVerificationUpdate({}, evidence).reason, "expected_not_selected");
  assert.equal(speakerVerificationUpdate({}, { ...evidence, expectedSpeakerId: "speaker-a" }).reason, "expected_not_matched");
  assert.equal(speakerVerificationUpdate({}, {
    ...evidence, expectedSpeakerId: "speaker-a", predictedSpeakerId: "speaker-b"
  }).reason, "unexpected_identity");
});
