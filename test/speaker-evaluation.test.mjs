import test from "node:test";
import assert from "node:assert/strict";
import { assessBenchmarkCoverage, calibrateSpeakerThreshold, evaluateSpeakerTrials } from "../lib/speaker-evaluation.mjs";

const speakers = [{ id: "a", name: "민수" }, { id: "b", name: "지수" }];
const trials = [
  { file: "a.wav", expectedSpeakerId: "a", scores: [0.88, 0.31] },
  { file: "b.wav", expectedSpeakerId: "b", scores: [0.2, 0.86] },
  { file: "unknown.wav", expectedSpeakerId: null, scores: [0.61, 0.55] },
  { file: "ambiguous.wav", expectedSpeakerId: "a", scores: [0.8, 0.79] }
];

test("reports identification, rejection and confusion metrics", () => {
  const report = evaluateSpeakerTrials(trials, speakers, { threshold: 0.72, margin: 0.04 });
  assert.deepEqual(report.counts, {
    trials: 4, knownTrials: 3, unknownTrials: 1,
    correct: 2, falseRejected: 1, misidentified: 0, falseAccepted: 0
  });
  assert.equal(report.rates.falseAcceptanceRate, 0);
  assert.equal(report.confusion["민수"]["거절"], 1);
});

test("calibrates only when genuine and unknown trials both exist", () => {
  const calibrated = calibrateSpeakerThreshold(trials, speakers);
  assert.equal(calibrated.ready, true);
  assert.ok(calibrated.threshold >= 0.55 && calibrated.threshold <= 0.9);
  assert.ok(calibrated.margin >= 0.02 && calibrated.margin <= 0.12);
  assert.equal(calibrateSpeakerThreshold(trials.filter(({ expectedSpeakerId }) => expectedSpeakerId), speakers).ready, false);
});

test("can preserve a fixed margin or reject an invalid calibration range", () => {
  assert.equal(calibrateSpeakerThreshold(trials, speakers, { margin: 0.07 }).margin, 0.07);
  assert.throws(() => calibrateSpeakerThreshold(trials, speakers, { minimumMargin: 0.1, maximumMargin: 0.05 }), /범위/);
});

test("marks undersized benchmark datasets as insufficient evidence", () => {
  const coverage = assessBenchmarkCoverage(trials, speakers, 2);
  assert.equal(coverage.ready, false);
  assert.equal(coverage.known.a.probes, 2);
  assert.equal(coverage.known.b.probes, 1);
  assert.equal(coverage.unknownProbes, 1);
  assert.ok(coverage.warnings.length >= 2);
});
