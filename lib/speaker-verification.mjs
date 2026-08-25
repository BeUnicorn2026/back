import { createHash } from "node:crypto";

function logEnergyEnvelope(pcm, sampleRate, frameMilliseconds) {
  if (!(pcm instanceof Int16Array) || !pcm.length) return [];
  const frameSamples = Math.max(1, Math.round(sampleRate * frameMilliseconds / 1_000));
  const envelope = [];
  for (let start = 0; start + frameSamples <= pcm.length; start += frameSamples) {
    let energy = 0;
    for (let index = start; index < start + frameSamples; index += 1) {
      const value = pcm[index] / 32_768;
      energy += value * value;
    }
    envelope.push(Math.log10(1e-8 + energy / frameSamples));
  }
  return envelope;
}

function pearsonAt(left, right, leftStart, rightStart, length) {
  let leftMean = 0;
  let rightMean = 0;
  for (let index = 0; index < length; index += 1) {
    leftMean += left[leftStart + index];
    rightMean += right[rightStart + index];
  }
  leftMean /= length;
  rightMean /= length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[leftStart + index] - leftMean;
    const rightValue = right[rightStart + index] - rightMean;
    covariance += leftValue * rightValue;
    leftVariance += leftValue * leftValue;
    rightVariance += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 1e-12 ? covariance / denominator : -1;
}

export function recordingEnvelopeSimilarity(leftPcm, rightPcm, options = {}) {
  const sampleRate = Number(options.sampleRate) || 16_000;
  const frameMilliseconds = Math.max(10, Number(options.frameMilliseconds) || 20);
  let left = logEnergyEnvelope(leftPcm, sampleRate, frameMilliseconds);
  let right = logEnergyEnvelope(rightPcm, sampleRate, frameMilliseconds);
  if (left.length > right.length) [left, right] = [right, left];
  const framesPerSecond = 1_000 / frameMilliseconds;
  const minimumFrames = Math.max(
    Math.round(framesPerSecond * (Number(options.minimumOverlapSeconds) || 4)),
    Math.floor(left.length * (Number(options.minimumOverlapRatio) || 0.8))
  );
  if (left.length < minimumFrames || right.length < minimumFrames) return null;
  let best = -1;
  for (let offset = -(left.length - minimumFrames); offset <= right.length - minimumFrames; offset += 1) {
    const leftStart = Math.max(0, -offset);
    const rightStart = Math.max(0, offset);
    const length = Math.min(left.length - leftStart, right.length - rightStart);
    if (length < minimumFrames) continue;
    best = Math.max(best, pearsonAt(left, right, leftStart, rightStart, length));
  }
  return best < -0.5 ? null : best;
}

export function speakerProbeFingerprint(pcm, options = {}) {
  if (!(pcm instanceof Int16Array) || !pcm.length) return "";
  const sampleRate = Number(options.sampleRate) || 16_000;
  const maximumSamples = Math.max(sampleRate, Math.floor(sampleRate * (Number(options.seconds) || 15)));
  const samples = pcm.subarray(0, maximumSamples);
  return createHash("sha256")
    .update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
    .digest("hex");
}

export function expectedSpeakerScore(scores, speakers, expectedSpeakerId, fallback = null) {
  const index = Array.isArray(speakers)
    ? speakers.findIndex(({ id }) => String(id) === String(expectedSpeakerId || ""))
    : -1;
  const value = index >= 0 && Array.isArray(scores) ? scores[index] : fallback;
  const score = value == null ? Number.NaN : Number(value);
  return Number.isFinite(score) ? score : null;
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
  const enrollmentAudioSimilarity = Number(evidence.enrollmentAudioSimilarity);
  const enrollmentAudioThreshold = Number(evidence.enrollmentAudioThreshold) || 0.985;
  if (Number.isFinite(enrollmentAudioSimilarity) && enrollmentAudioSimilarity >= enrollmentAudioThreshold) {
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
