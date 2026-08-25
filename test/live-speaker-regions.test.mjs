import assert from "node:assert/strict";
import test from "node:test";
import { speakerRegionSampleRange } from "../lib/live-speaker-regions.mjs";

test("keeps sub-second diarized speech available for cross-turn accumulation", () => {
  assert.deepEqual(speakerRegionSampleRange(
    { start: 3, end: 3.4 },
    { earliestSample: 0, latestSample: 64_000 },
    16_000
  ), { firstSample: 48_000, lastSample: 54_400 });
});

test("clips a diarized region to retained audio history and rejects empty ranges", () => {
  assert.deepEqual(speakerRegionSampleRange(
    { start: 1, end: 3 },
    { earliestSample: 24_000, latestSample: 40_000 },
    16_000
  ), { firstSample: 24_000, lastSample: 40_000 });
  assert.equal(speakerRegionSampleRange(
    { start: 4, end: 5 },
    { earliestSample: 0, latestSample: 40_000 },
    16_000
  ), null);
});
