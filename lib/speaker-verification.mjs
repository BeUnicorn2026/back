import { createHash } from "node:crypto";

export function speakerProbeFingerprint(pcm, options = {}) {
  if (!(pcm instanceof Int16Array) || !pcm.length) return "";
  const sampleRate = Number(options.sampleRate) || 16_000;
  const maximumSamples = Math.max(sampleRate, Math.floor(sampleRate * (Number(options.seconds) || 15)));
  const samples = pcm.subarray(0, maximumSamples);
  return createHash("sha256")
    .update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
    .digest("hex");
}

export function speakerVerificationUpdate(speaker, evidence = {}) {
  const fingerprint = String(evidence.fingerprint || "");
  const enrollmentFingerprints = Array.isArray(speaker?.enrollmentFingerprints)
    ? speaker.enrollmentFingerprints.filter(Boolean) : [];
  const verificationFingerprints = Array.isArray(speaker?.verificationFingerprints)
    ? speaker.verificationFingerprints.filter(Boolean) : [];
  if (evidence.independentRecording !== true) {
    return { recorded: false, attemptRecorded: false, reason: "not_confirmed", changes: null };
  }
  const expectedSpeakerId = String(evidence.expectedSpeakerId || "");
  const predictedSpeakerId = String(evidence.predictedSpeakerId || "");
  if (!expectedSpeakerId) return { recorded: false, attemptRecorded: false, reason: "expected_not_selected", changes: null };
  if (!fingerprint || !enrollmentFingerprints.length) {
    return { recorded: false, attemptRecorded: false, reason: "needs_new_enrollment", changes: null };
  }
  if (enrollmentFingerprints.includes(fingerprint)) {
    return { recorded: false, attemptRecorded: false, reason: "enrollment_audio", changes: null };
  }
  if (verificationFingerprints.includes(fingerprint)) {
    return { recorded: false, attemptRecorded: false, reason: "duplicate_probe", changes: null };
  }
  const success = predictedSpeakerId === expectedSpeakerId;
  const previousSuccesses = Math.max(0, Number(speaker?.verificationSuccessCount ?? speaker?.crossSessionVerificationCount) || 0);
  const previousAttempts = Math.max(previousSuccesses, Number(speaker?.verificationAttemptCount) || 0);
  const previousFailures = Math.max(0, Number(speaker?.verificationFailureCount) || (previousAttempts - previousSuccesses));
  const score = Number(evidence.score);
  const previousAverage = Number(speaker?.averageVerificationScore) || 0;
  const successCount = previousSuccesses + (success ? 1 : 0);
  const attemptCount = previousAttempts + 1;
  const failedCount = previousFailures + (success ? 0 : 1);
  const verifiedAt = evidence.verifiedAt || new Date().toISOString();
  const changes = {
    crossSessionVerificationCount: successCount,
    verificationSuccessCount: successCount,
    verificationAttemptCount: attemptCount,
    verificationFailureCount: failedCount,
    lastVerificationOutcome: success ? "matched" : predictedSpeakerId ? "misidentified" : "rejected",
    lastVerifiedAt: verifiedAt,
    lastVerificationScore: Number.isFinite(score) ? score : null,
    lastVerificationQualityScore: Number(evidence.qualityScore) || null,
    verificationFingerprints: [...verificationFingerprints, fingerprint].slice(-20)
  };
  if (success) {
    changes.lowestVerificationScore = Number.isFinite(score)
      ? Math.min(Number.isFinite(Number(speaker?.lowestVerificationScore)) ? Number(speaker.lowestVerificationScore) : score, score)
      : speaker?.lowestVerificationScore ?? null;
    changes.averageVerificationScore = Number.isFinite(score)
      ? (previousAverage * previousSuccesses + score) / successCount : previousAverage || null;
  }
  return {
    recorded: success,
    attemptRecorded: true,
    reason: success ? "independent_probe" : predictedSpeakerId ? "unexpected_identity" : "expected_not_matched",
    changes
  };
}
