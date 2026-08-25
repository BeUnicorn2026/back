import assert from "node:assert/strict";
import test from "node:test";
import { serviceReadiness } from "../lib/service-readiness.mjs";

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
