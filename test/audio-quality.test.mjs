import test from "node:test";
import assert from "node:assert/strict";
import { analyzePcmQuality, isSpeakerInferenceQuality } from "../lib/audio-quality.mjs";

function makePcm({ seconds = 6, amplitude = 5_000, voicedRatio = 0.6 } = {}) {
  const samples = new Int16Array(seconds * 16_000);
  const voicedSamples = Math.floor(samples.length * voicedRatio);
  for (let index = 0; index < voicedSamples; index += 1) {
    samples[index] = Math.round(Math.sin(index / 11) * amplitude);
  }
  return samples;
}

test("accepts a sufficiently loud recording with sustained speech", () => {
  const quality = analyzePcmQuality(makePcm());
  assert.equal(quality.usable, true);
  assert.ok(quality.voicedRatio >= 0.5);
  assert.ok(quality.score >= 70);
});

test("rejects quiet and mostly silent enrollment audio", () => {
  const quality = analyzePcmQuality(makePcm({ amplitude: 100, voicedRatio: 0.08 }));
  assert.equal(quality.usable, false);
  assert.ok(quality.warnings.length >= 2);
});

test("detects clipping", () => {
  const pcm = makePcm({ amplitude: 32_767, voicedRatio: 1 });
  for (let index = 0; index < pcm.length; index += 4) pcm[index] = 32_767;
  const quality = analyzePcmQuality(pcm);
  assert.ok(quality.clippingRatio > 0.005);
  assert.ok(quality.warnings.some((warning) => warning.includes("찌그러질")));
});

test("gates short speaker inference without applying the five second enrollment rule", () => {
  const pcm = makePcm({ seconds: 2 });
  const quality = analyzePcmQuality(pcm);
  assert.equal(quality.usable, false);
  assert.equal(isSpeakerInferenceQuality(quality), true);
  assert.equal(isSpeakerInferenceQuality(analyzePcmQuality(new Int16Array(32_000))), false);
});
