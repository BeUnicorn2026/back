const alphabeticLabel = (index) => {
  let value = Number(index) + 1;
  let label = "";

  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }

  return label;
};

export function chooseKnownSpeaker(scores, speakers, options = {}) {
  return speakerDecision(scores, speakers, options).identity;
}

export function speakerDecision(scores, speakers, options = {}) {
  if (!Array.isArray(scores) || !scores.length || scores.length !== speakers.length) {
    return {
      identity: null, accepted: false, reason: "invalid_scores",
      bestScore: null, secondScore: null, scoreGap: null,
      requiredThreshold: null, requiredMargin: Number(options.margin ?? 0.04)
    };
  }

  const threshold = Number(options.threshold ?? 0.72);
  const margin = Number(options.margin ?? 0.04);
  const ranked = scores
    .map((score, index) => ({ score: Number(score), speaker: speakers[index] }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score);

  const best = ranked[0];
  const second = ranked[1];
  const bestThreshold = Number(best?.speaker?.matchThreshold ?? threshold);
  const scoreGap = best && second ? best.score - second.score : null;
  const base = {
    bestScore: best?.score ?? null,
    secondScore: second?.score ?? null,
    scoreGap,
    requiredThreshold: Number.isFinite(bestThreshold) ? bestThreshold : threshold,
    requiredMargin: margin
  };
  if (!best || best.score < bestThreshold) {
    return { ...base, identity: null, accepted: false, reason: "below_threshold" };
  }
  if (second && scoreGap < margin) {
    return { ...base, identity: null, accepted: false, reason: "ambiguous" };
  }

  return {
    ...base,
    identity: { id: best.speaker.id, name: best.speaker.name, score: best.score },
    accepted: true,
    reason: "accepted"
  };
}

export class SpeakerIdentityTracker {
  constructor() {
    this.clusters = new Map();
  }

  identify(clusterId, scores, speakers, options = {}) {
    const key = String(clusterId ?? "0");
    const previous = this.clusters.get(key);
    const smoothing = Number(options.smoothing ?? 0.42);
    const smoothed = scores.map((score, index) => {
      const prior = Number(previous?.scores?.[index]);
      return Number.isFinite(prior) ? prior * (1 - smoothing) + Number(score) * smoothing : Number(score);
    });
    if (previous?.manual) {
      this.clusters.set(key, { ...previous, scores: smoothed });
      return previous.identity;
    }
    let identity = chooseKnownSpeaker(smoothed, speakers, options);

    if (previous?.identity) {
      const currentIndex = speakers.findIndex(({ id }) => id === previous.identity.id);
      const releaseThreshold = Number(speakers[currentIndex]?.matchThreshold ?? options.threshold ?? 0.72) - 0.08;
      const currentScore = smoothed[currentIndex];
      const challengerScore = Math.max(...smoothed.filter((_score, index) => index !== currentIndex));
      if (currentIndex >= 0 && currentScore >= releaseThreshold && currentScore + 0.06 >= challengerScore) {
        identity = { ...previous.identity, score: currentScore };
      }
    }

    this.clusters.set(key, { scores: smoothed, identity });
    return identity;
  }

  correct(clusterId, speaker) {
    if (!speaker?.id || !speaker?.name) return null;
    const key = String(clusterId ?? "0");
    const previous = this.clusters.get(key);
    const identity = { id: speaker.id, name: speaker.name, score: null, manual: true };
    this.clusters.set(key, { scores: previous?.scores || [], identity, manual: true });
    return identity;
  }

  current(clusterId) {
    return this.clusters.get(String(clusterId ?? "0"))?.identity || null;
  }
}

export function diarizedAudioRegions(words, options = {}) {
  const minimumDuration = Number(options.minimumDuration ?? 1);
  const maximumDuration = Number(options.maximumDuration ?? 8);
  const maximumGap = Number(options.maximumGap ?? 0.6);
  const regions = [];

  for (const word of Array.isArray(words) ? words : []) {
    const start = Math.max(0, Number(word?.start) || 0);
    const end = Math.max(start, Number(word?.end) || start);
    const sourceSpeaker = String(Number.isInteger(Number(word?.speaker)) ? Number(word.speaker) : 0);
    const previous = regions.at(-1);
    if (previous && previous.sourceSpeaker === sourceSpeaker && start - previous.end <= maximumGap
      && end - previous.start <= maximumDuration) {
      previous.end = end;
      previous.wordCount += 1;
    } else {
      regions.push({ sourceSpeaker, start, end, wordCount: 1 });
    }
  }

  return regions.filter(({ start, end }) => end - start >= minimumDuration);
}

export function resolveWordSpeaker(word, recognitionFrames, speakers, options = {}) {
  const start = Number(word?.start ?? 0);
  const end = Number(word?.end ?? start);
  const diarizedIndex = Number.isInteger(Number(word?.speaker)) ? Number(word.speaker) : 0;
  const sourceSpeaker = String(diarizedIndex);
  const exactClusterFrames = recognitionFrames.filter((frame) =>
    frame.sourceSpeaker === sourceSpeaker && frame.end >= start && frame.start <= end);
  const overlapping = exactClusterFrames.length
    ? exactClusterFrames
    : recognitionFrames.filter((frame) => frame.end >= start && frame.start <= end && frame.sourceSpeaker == null);
  const candidates = overlapping.length
    ? overlapping
    : recognitionFrames.filter((frame) => frame.sourceSpeaker === sourceSpeaker
      && Math.abs(((frame.start + frame.end) / 2) - ((start + end) / 2)) <= 0.75);

  if (!recognitionFrames.length && end < 2.5) {
    return { label: "화자 확인 중", known: false, confidence: null };
  }

  if (candidates.length && speakers.length) {
    const averages = speakers.map((_speaker, index) => {
      const values = candidates.map((frame) => ({
        score: Number(frame.scores[index]),
        weight: Math.max(0.25, Number(frame.weight) || 1)
      })).filter(({ score }) => Number.isFinite(score));
      const totalWeight = values.reduce((sum, { weight }) => sum + weight, 0);
      return totalWeight ? values.reduce((sum, { score, weight }) => sum + score * weight, 0) / totalWeight : 0;
    });
    const known = options.tracker
      ? options.tracker.identify(diarizedIndex, averages, speakers, options)
      : chooseKnownSpeaker(averages, speakers, options);
    if (known) return {
      label: known.name,
      known: true,
      confidence: known.manual ? null : known.score,
      corrected: Boolean(known.manual)
    };
  }

  const tracked = options.tracker?.current(diarizedIndex);
  if (tracked) return {
    label: tracked.name,
    known: true,
    confidence: tracked.manual ? null : tracked.score,
    corrected: Boolean(tracked.manual)
  };
  return { label: `미등록 화자 ${alphabeticLabel(diarizedIndex)}`, known: false, confidence: null };
}

export function wordsToSegments(words, recognitionFrames, speakers, options = {}) {
  const segments = [];

  for (const word of Array.isArray(words) ? words : []) {
    const text = String(word?.punctuated_word ?? word?.word ?? "").trim();
    if (!text) continue;
    const identity = resolveWordSpeaker(word, recognitionFrames, speakers, options);
    const sourceSpeaker = String(Number.isInteger(Number(word?.speaker)) ? Number(word.speaker) : 0);
    const start = Number(word.start ?? 0);
    const end = Number(word.end ?? start);
    const wordConfidence = Number(word?.confidence);
    const hasWordConfidence = Number.isFinite(wordConfidence);
    const previous = segments.at(-1);

    if (previous && previous.speaker === identity.label && previous.sourceSpeaker === sourceSpeaker && start - previous.end < 1.25) {
      previous.text += /^[,.!?;:)]/.test(text) ? text : ` ${text}`;
      previous.end = end;
      if (identity.confidence != null) previous.confidence = Math.max(previous.confidence ?? 0, identity.confidence);
      if (hasWordConfidence) {
        previous.transcriptConfidenceTotal += wordConfidence;
        previous.transcriptConfidenceCount += 1;
        previous.transcriptConfidence = previous.transcriptConfidenceTotal / previous.transcriptConfidenceCount;
      }
      continue;
    }

    segments.push({
      speaker: identity.label,
      known: identity.known,
      confidence: identity.confidence,
      ...(identity.corrected ? { corrected: true } : {}),
      sourceSpeaker,
      start,
      end,
      text,
      ...(hasWordConfidence ? { transcriptConfidence: wordConfidence } : {}),
      transcriptConfidenceTotal: hasWordConfidence ? wordConfidence : 0,
      transcriptConfidenceCount: hasWordConfidence ? 1 : 0
    });
  }

  return segments.map(({ transcriptConfidenceTotal: _total, transcriptConfidenceCount: _count, ...segment }) => segment);
}

export function wordsToTranscriptSegments(words) {
  const normalized = (Array.isArray(words) ? words : []).map((word) => ({
    start: Math.max(0, Number(word?.start) || 0),
    end: Math.max(0, Number(word?.end) || Number(word?.start) || 0),
    text: String(word?.punctuated_word ?? word?.word ?? "").trim()
  })).filter(({ text }) => text);

  if (!normalized.length) return [];
  const confidenceValues = (Array.isArray(words) ? words : [])
    .map(({ confidence }) => Number(confidence)).filter(Number.isFinite);
  return [{
    speaker: "실시간 STT",
    known: false,
    confidence: null,
    sourceSpeaker: null,
    start: normalized[0].start,
    end: normalized.at(-1).end,
    text: normalized.map(({ text }, index) => index > 0 && !/^[,.!?;:)]/.test(text) ? ` ${text}` : text).join(""),
    ...(confidenceValues.length ? {
      transcriptConfidence: confidenceValues.reduce((sum, confidence) => sum + confidence, 0) / confidenceValues.length
    } : {})
  }];
}
