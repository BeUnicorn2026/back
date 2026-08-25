import assert from "node:assert/strict";
import test from "node:test";
import { computeSpeakerFbank, speakerFbankInfo } from "../lib/speaker-fbank.mjs";

test("extracts deterministic 80-bin CMN features from 16 kHz PCM", () => {
  const pcm = new Int16Array(16_000);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = Math.round(8_000 * Math.sin(2 * Math.PI * 180 * index / 16_000));
  }
  const first = computeSpeakerFbank(pcm);
  const second = computeSpeakerFbank(pcm);
  assert.equal(first.frames, 98);
  assert.equal(first.bins, 80);
  assert.equal(first.data.length, first.frames * first.bins);
  assert.deepEqual(first.data, second.data);
  for (let bin = 0; bin < first.bins; bin += 1) {
    let mean = 0;
    for (let frame = 0; frame < first.frames; frame += 1) mean += first.data[frame * first.bins + bin];
    assert.ok(Math.abs(mean / first.frames) < 1e-4);
  }
});

test("documents the WeSpeaker-compatible feature contract and rejects invalid input", () => {
  assert.deepEqual(speakerFbankInfo, {
    sampleRate: 16_000,
    frameLengthSamples: 400,
    frameShiftSamples: 160,
    fftSize: 512,
    melBins: 80,
    window: "hamming",
    cepstralMeanNormalization: true
  });
  assert.throws(() => computeSpeakerFbank(new Float32Array(16_000)), /Int16Array/);
  assert.throws(() => computeSpeakerFbank(new Int16Array(16_000), 8_000), /16kHz/);
  assert.throws(() => computeSpeakerFbank(new Int16Array(100)), /너무 짧습니다/);
});
