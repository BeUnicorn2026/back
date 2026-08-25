export function serviceReadiness(configuration) {
  const checks = {
    deepgram: Boolean(configuration.deepgram),
    openai: Boolean(configuration.openai),
    email: Boolean(configuration.email),
    biometricEncryption: Boolean(configuration.biometricEncryption),
    speakerModel: Boolean(configuration.speakerModel),
    speakerStorage: Boolean(configuration.speakerStorage)
  };
  const missing = Object.entries(checks).filter(([, ready]) => !ready).map(([name]) => name);
  return {
    ready: configuration.environment !== "production" || missing.length === 0,
    checks,
    missing
  };
}

export function productionEnvironmentIssues(environment, variables = {}) {
  if (environment !== "production") return [];
  const required = [
    "EMAIL_VERIFICATION_SECRET",
    "VOICE_BIOMETRIC_KEY",
    "DEEPGRAM_API_KEY",
    "OPENAI_API_KEY",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL"
  ];
  const missing = required.filter((name) => !String(variables[name] || "").trim());
  if (variables.SPEAKER_STORAGE === "blob" && !String(variables.BLOB_READ_WRITE_TOKEN || "").trim()) {
    missing.push("BLOB_READ_WRITE_TOKEN");
  }
  return missing;
}
