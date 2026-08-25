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
    return { recorded: false, reason: "not_confirmed", changes: null };
  }
  if (!fingerprint || !enrollmentFingerprints.length) {
    return { recorded: false, reason: "needs_new_enrollment", changes: null };
  }
  if (enrollmentFingerprints.includes(fingerprint)) {
    return { recorded: false, reason: "enrollment_audio", changes: null };
  }
  if (verificationFingerprints.includes(fingerprint)) {
    return { recorded: false, reason: "duplicate_probe", changes: null };
  }
  const previousCount = Math.max(0, Number(speaker?.crossSessionVerificationCount) || 0);
  const score = Number(evidence.score);
  const previousAverage = Number(speaker?.averageVerificationScore) || 0;
  const count = previousCount + 1;
  return {
    recorded: true,
    reason: "independent_probe",
    changes: {
      crossSessionVerificationCount: count,
      lastVerifiedAt: evidence.verifiedAt || new Date().toISOString(),
      lastVerificationScore: Number.isFinite(score) ? score : null,
      lowestVerificationScore: Number.isFinite(score)
        ? Math.min(Number.isFinite(Number(speaker?.lowestVerificationScore)) ? Number(speaker.lowestVerificationScore) : score, score)
        : speaker?.lowestVerificationScore ?? null,
      averageVerificationScore: Number.isFinite(score)
        ? (previousAverage * previousCount + score) / count : previousAverage || null,
      lastVerificationQualityScore: Number(evidence.qualityScore) || null,
      verificationFingerprints: [...verificationFingerprints, fingerprint].slice(-20)
    }
  };
}
