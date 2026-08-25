import test from "node:test";
import assert from "node:assert/strict";
import {
  chooseKnownSpeaker, diarizedAudioRegions, speakerDecision, SpeakerIdentityTracker, wordsToSegments, wordsToTranscriptSegments
} from "../lib/speaker-matching.mjs";
import { assessNewSpeakerSeparation, assessSpeakerProfileExtension, cosineSimilarity, mergeSpeakerProfileVectors, pcmRms, speakerInferenceWindows } from "../lib/speaker-embedding-model.mjs";

const speakers = [{ id: "one", name: "민수" }, { id: "two", name: "지수" }];

test("accepts a registered speaker above threshold and margin", () => {
  assert.deepEqual(chooseKnownSpeaker([0.91, 0.32], speakers), { id: "one", name: "민수", score: 0.91 });
});

test("rejects ambiguous and low-scoring voices", () => {
  assert.equal(chooseKnownSpeaker([0.68, 0.2], speakers), null);
  assert.equal(chooseKnownSpeaker([0.92, 0.89], speakers), null);
});

test("explains whether a probe failed its threshold or separation margin", () => {
  const calibrated = [{ id: "one", name: "민수", matchThreshold: 0.74 }, { id: "two", name: "지수" }];
  const quiet = speakerDecision([0.7, 0.2], calibrated, { margin: 0.04 });
  assert.equal(quiet.reason, "below_threshold");
  assert.equal(quiet.requiredThreshold, 0.74);
  const ambiguous = speakerDecision([0.78, 0.76], calibrated, { margin: 0.04 });
  assert.equal(ambiguous.reason, "ambiguous");
  assert.ok(ambiguous.scoreGap < ambiguous.requiredMargin);
  const accepted = speakerDecision([0.82, 0.7], calibrated, { margin: 0.04 });
  assert.equal(accepted.identity.name, "민수");
  assert.equal(accepted.reason, "accepted");
});

test("uses enrollment-specific thresholds and stabilizes a diarized speaker cluster", () => {
  const calibrated = [{ id: "one", name: "민수", matchThreshold: 0.78 }, { id: "two", name: "지수" }];
  assert.equal(chooseKnownSpeaker([0.76, 0.2], calibrated), null);

  const tracker = new SpeakerIdentityTracker();
  assert.equal(tracker.identify(0, [0.9, 0.2], speakers)?.name, "민수");
  assert.equal(tracker.identify(0, [0.69, 0.67], speakers)?.name, "민수");
  assert.equal(tracker.identify(1, [0.2, 0.91], speakers)?.name, "지수");
});

test("does not count the same acoustic frame once per transcript word", () => {
  const tracker = new SpeakerIdentityTracker();
  const frame = { start: 0, end: 1, sourceSpeaker: "0", scores: [0.76, 0.7], weight: 1 };
  const first = wordsToSegments([
    { start: 0.1, end: 0.3, word: "같은", speaker: 0 },
    { start: 0.35, end: 0.55, word: "관측", speaker: 0 },
    { start: 0.6, end: 0.8, word: "입니다", speaker: 0 }
  ], [frame], speakers, { tracker });
  assert.ok(first.every(({ speaker }) => speaker === "미등록 화자 A"));

  const repeated = wordsToSegments([
    { start: 0.15, end: 0.4, word: "다시", speaker: 0 }
  ], [frame], speakers, { tracker });
  assert.equal(repeated[0].speaker, "미등록 화자 A");

  const independentFrame = { start: 1.1, end: 2.2, sourceSpeaker: "0", scores: [0.84, 0.58], weight: 1.1 };
  const confirmed = wordsToSegments([
    { start: 1.2, end: 1.8, word: "확인", speaker: 0 }
  ], [independentFrame], speakers, { tracker });
  assert.equal(confirmed[0].speaker, "민수");
});

test("accepts one short observation only when its identity evidence is strong", () => {
  const uncertain = new SpeakerIdentityTracker();
  assert.equal(uncertain.identify("0", [0.76, 0.69], speakers, {
    observationId: "short-uncertain", observationWeight: 1
  }), null);

  const strong = new SpeakerIdentityTracker();
  assert.equal(strong.identify("0", [0.91, 0.3], speakers, {
    observationId: "short-strong", observationWeight: 1
  })?.name, "민수");
});

test("manual cluster correction overrides later model scores without claiming model confidence", () => {
  const tracker = new SpeakerIdentityTracker();
  assert.equal(tracker.identify(0, [0.91, 0.2], speakers)?.name, "민수");
  assert.equal(tracker.correct(0, speakers[1])?.name, "지수");
  const result = wordsToSegments(
    [{ start: 3, end: 4, word: "확인했습니다", speaker: 0 }],
    [{ start: 3, end: 4, sourceSpeaker: "0", scores: [0.96, 0.12] }],
    speakers,
    { tracker }
  );
  assert.equal(result[0].speaker, "지수");
  assert.equal(result[0].confidence, null);
  assert.equal(result[0].corrected, true);
});

test("labels words with known names and keeps an unknown diarization label", () => {
  const frames = [
    { start: 0, end: 1, scores: [0.9, 0.1] },
    { start: 1, end: 2, scores: [0.88, 0.12] }
  ];
  const words = [
    { start: 0.1, end: 0.5, word: "안녕", speaker: 0 },
    { start: 0.6, end: 1.0, word: "하세요", speaker: 0 },
    { start: 3.0, end: 3.4, word: "누구세요", speaker: 1 }
  ];

  assert.deepEqual(wordsToSegments(words, frames, speakers), [
    { speaker: "민수", known: true, confidence: 0.9, sourceSpeaker: "0", start: 0.1, end: 1, text: "안녕 하세요" },
    { speaker: "미등록 화자 B", known: false, confidence: null, sourceSpeaker: "1", start: 3, end: 3.4, text: "누구세요" }
  ]);
});

test("does not call the first two seconds an unknown speaker before identification is ready", () => {
  const [segment] = wordsToSegments([{ start: 0, end: 1.2, word: "안녕하세요", speaker: 0 }], [], speakers);
  assert.equal(segment.speaker, "화자 확인 중");
});

test("reuses a stable cluster identity when a later word has no overlapping frame", () => {
  const tracker = new SpeakerIdentityTracker();
  const frames = [{ start: 0, end: 2, scores: [0.9, 0.2] }];
  const result = wordsToSegments([
    { start: 0.2, end: 1.2, word: "첫째", speaker: 0 },
    { start: 4, end: 5, word: "둘째", speaker: 0 }
  ], frames, speakers, { tracker });
  assert.deepEqual(result.map(({ speaker }) => speaker), ["민수", "민수"]);
});

test("extracts only sufficiently long contiguous regions from each diarized speaker", () => {
  assert.deepEqual(diarizedAudioRegions([
    { start: 0, end: 0.6, speaker: 0 },
    { start: 0.7, end: 1.4, speaker: 0 },
    { start: 1.45, end: 2.7, speaker: 1 },
    { start: 3.8, end: 4.2, speaker: 1 }
  ]), [
    { sourceSpeaker: "0", start: 0, end: 1.4, wordCount: 2 },
    { sourceSpeaker: "1", start: 1.45, end: 2.7, wordCount: 1 }
  ]);
});

test("does not coerce missing diarization labels into speaker A", () => {
  assert.deepEqual(diarizedAudioRegions([
    { start: 0, end: 1.5, word: "누락" },
    { start: 2, end: 3.2, word: "정상", speaker: 1 }
  ]), [{ sourceSpeaker: "1", start: 2, end: 3.2, wordCount: 1 }]);

  const [segment] = wordsToSegments([
    { start: 3, end: 4, word: "화자값없음" }
  ], [], speakers);
  assert.equal(segment.speaker, "화자 정보 없음");
  assert.equal(segment.sourceSpeaker, null);
});

test("does not mix overlapping embeddings from another diarization cluster", () => {
  const frames = [
    { start: 0, end: 2, sourceSpeaker: "1", scores: [0.1, 0.95], weight: 2 },
    { start: 0, end: 2, sourceSpeaker: "0", scores: [0.91, 0.2], weight: 2 }
  ];
  const [segment] = wordsToSegments([{ start: 0.4, end: 1.2, word: "안녕하세요", speaker: 0 }], frames, speakers);
  assert.equal(segment.speaker, "민수");
  assert.equal(segment.confidence, 0.91);
});

test("computes normalized speaker similarity and detects silence", () => {
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0])), 1);
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
  assert.equal(pcmRms(new Int16Array(160)), 0);
  assert.ok(pcmRms(new Int16Array([16384, -16384])) > 0.49);
});

test("selects dense full-length speech windows without increasing real-time inference count", () => {
  const pcm = new Int16Array(8 * 16_000);
  for (let index = 4 * 16_000; index < 7 * 16_000; index += 1) {
    pcm[index] = Math.round(Math.sin(index / 13) * 4_000);
  }
  const [best] = speakerInferenceWindows(pcm);
  assert.equal(best.length, 3 * 16_000);
  assert.ok(pcmRms(best) > pcmRms(pcm));
  const diverse = speakerInferenceWindows(pcm, { maximumEmbeddings: 3 });
  assert.equal(diverse.length, 3);
  assert.ok(diverse.every((window) => window.length === 3 * 16_000));
});

test("merges and deduplicates speaker profiles across enrollment sessions", () => {
  const result = mergeSpeakerProfileVectors([
    [new Float32Array([1, 0]), new Float32Array([1, 0])],
    [new Float32Array([0.8, 0.2]), new Float32Array([0.7, 0.3])]
  ]);
  assert.equal(result.vectors.length, 4);
  assert.ok(result.consistency > 0.9);
  assert.ok(result.matchThreshold >= 0.68 && result.matchThreshold <= 0.82);
});

test("accepts matching enrollment extensions and rejects another registered speaker", () => {
  const target = { id: "one", name: "민수", matchThreshold: 0.72, profiles: [new Float32Array([1, 0])] };
  const other = { id: "two", name: "지수", profiles: [new Float32Array([0, 1])] };
  const accepted = assessSpeakerProfileExtension(target, [new Float32Array([0.98, 0.1])], [other]);
  assert.equal(accepted.accepted, true);
  const rejected = assessSpeakerProfileExtension(target, [new Float32Array([0.05, 0.99])], [other]);
  assert.equal(rejected.accepted, false);
  assert.match(rejected.reason, /지수|일치하지 않습니다/);
});

test("rejects registering a new name for an existing voice", () => {
  const existing = [{ id: "one", name: "민수", profiles: [new Float32Array([1, 0])] }];
  const collision = assessNewSpeakerSeparation([new Float32Array([0.99, 0.01])], existing);
  assert.equal(collision.accepted, false);
  assert.equal(collision.nearest.name, "민수");
  assert.match(collision.reason, /기존 화자에 샘플/);
  assert.equal(assessNewSpeakerSeparation([new Float32Array([0, 1])], existing).accepted, true);
});

test("creates a speaker-free segment for isolated STT testing", () => {
  assert.deepEqual(wordsToTranscriptSegments([
    { start: 0.2, end: 0.6, word: "안녕" },
    { start: 0.7, end: 1.1, punctuated_word: "하세요." }
  ]), [{
    speaker: "실시간 STT", known: false, confidence: null, sourceSpeaker: null,
    start: 0.2, end: 1.1, text: "안녕 하세요."
  }]);
});

test("keeps STT confidence separate from speaker similarity", () => {
  const segments = wordsToSegments([
    { start: 0, end: 0.5, word: "정확도", confidence: 0.9, speaker: 0 },
    { start: 0.6, end: 1, word: "확인", confidence: 0.7, speaker: 0 }
  ], [{ start: 0, end: 1, sourceSpeaker: "0", scores: [0.86] }], [{ id: "one", name: "민수" }]);
  assert.equal(segments[0].confidence, 0.86);
  assert.equal(segments[0].transcriptConfidence, 0.8);
  assert.equal("transcriptConfidenceTotal" in segments[0], false);
});
