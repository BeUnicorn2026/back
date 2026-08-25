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
