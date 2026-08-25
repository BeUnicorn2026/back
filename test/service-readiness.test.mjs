import assert from "node:assert/strict";
import test from "node:test";
import { productionEnvironmentIssues, serviceReadiness } from "../lib/service-readiness.mjs";

test("production readiness requires every core meeting service", () => {
  const degraded = serviceReadiness({
    environment: "production", deepgram: true, openai: false, email: true,
    biometricEncryption: false, speakerModel: true, speakerStorage: true
  });
  assert.equal(degraded.ready, false);
  assert.deepEqual(degraded.missing, ["openai", "biometricEncryption"]);

  const ready = serviceReadiness({
    environment: "production", deepgram: true, openai: true, email: true,
    biometricEncryption: true, speakerModel: true, speakerStorage: true
  });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missing, []);
});

test("development readiness allows intentionally unconfigured providers", () => {
  assert.equal(serviceReadiness({ environment: "development" }).ready, true);
});

test("reports every missing production environment variable at once", () => {
  const missing = productionEnvironmentIssues("production", { SPEAKER_STORAGE: "blob" });
  assert.deepEqual(missing, [
    "EMAIL_VERIFICATION_SECRET", "VOICE_BIOMETRIC_KEY", "DEEPGRAM_API_KEY",
    "OPENAI_API_KEY", "RESEND_API_KEY", "RESEND_FROM_EMAIL", "BLOB_READ_WRITE_TOKEN"
  ]);
  assert.deepEqual(productionEnvironmentIssues("development", {}), []);
  assert.deepEqual(productionEnvironmentIssues("production", {
    EMAIL_VERIFICATION_SECRET: "configured",
    VOICE_BIOMETRIC_KEY: "configured",
    DEEPGRAM_API_KEY: "configured",
    OPENAI_API_KEY: "configured",
    RESEND_API_KEY: "configured",
    RESEND_FROM_EMAIL: "configured"
  }), []);
});
