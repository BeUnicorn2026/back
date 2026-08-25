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

function diarizedSpeakerIndex(value) {
  if (value == null || value === "") return null;
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function acceptedSpeakerIdentity(speaker, score, extras = {}) {
  const speakerProfileId = speaker?.speakerProfileId ?? speaker?.id;
  const userId = speaker?.userId ?? speaker?.createdBy;
  return {
    id: speaker?.id ?? speakerProfileId,
    name: speaker?.name ?? speaker?.displayName,
    ...(speaker?.createdBy != null ? { createdBy: speaker.createdBy } : {}),
    ...(userId != null ? { userId } : {}),
    ...(speakerProfileId != null ? { speakerProfileId } : {}),
    score,
    ...extras
  };
}

function resolvedIdentityMetadata(identity) {
  const userId = identity?.userId ?? identity?.createdBy;
  if (userId == null) return {};
  return {
    userId,
    speakerProfileId: identity?.speakerProfileId ?? identity?.id
  };
}

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
  const profileThreshold = Number(best?.speaker?.matchThreshold);
  const bestThreshold = Number.isFinite(profileThreshold) ? Math.max(threshold, profileThreshold) : threshold;
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
    identity: acceptedSpeakerIdentity(best.speaker, best.score),
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
    const observationId = String(options.observationId || "");
    if (observationId && previous?.observationIds?.has(observationId)) return previous.identity || null;
    const observationIds = new Set(previous?.observationIds || []);
    if (observationId) {
      observationIds.add(observationId);
      while (observationIds.size > 64) observationIds.delete(observationIds.values().next().value);
    }
    const observationWeight = Math.max(0.25, Math.min(8, Number(options.observationWeight) || 1));
    const previousWeight = Math.min(12, Math.max(0, Number(previous?.evidenceWeight) || 0));
    const evidenceWeight = Math.min(20, previousWeight + observationWeight);
    const smoothing = previousWeight ? observationWeight / (previousWeight + observationWeight) : 1;
    const smoothed = scores.map((score, index) => {
      const prior = Number(previous?.scores?.[index]);
      return Number.isFinite(prior) ? prior * (1 - smoothing) + Number(score) * smoothing : Number(score);
    });
    if (previous?.manual) {
      this.clusters.set(key, { ...previous, scores: smoothed, evidenceWeight, observationIds });
      return previous.identity;
    }
    const rawDecision = speakerDecision(scores, speakers, options);
    const contradictionScoreBuffer = Number(options.contradictionScoreBuffer ?? 0.06);
    const contradictionMarginBuffer = Number(options.contradictionMarginBuffer ?? 0.03);
    const strongContradiction = previous?.identity
      && rawDecision.accepted
      && rawDecision.identity.id !== previous.identity.id
      && rawDecision.bestScore >= rawDecision.requiredThreshold + contradictionScoreBuffer
      && (rawDecision.scoreGap == null
        || rawDecision.scoreGap >= rawDecision.requiredMargin + contradictionMarginBuffer);

    if (strongContradiction) {
      const sameChallenger = previous?.contradictionSpeakerId === rawDecision.identity.id;
      const contradictionCount = sameChallenger
        ? Number(previous?.contradictionCount || 0) + 1
        : 1;
      const contradictionWeight = sameChallenger
        ? Number(previous?.contradictionWeight || 0) + observationWeight
        : observationWeight;
      const requiredObservations = Math.max(2, Number(options.switchObservationCount) || 2);
      const requiredEvidence = Math.max(2, Number(options.switchEvidenceWeight) || 2);

      if (contradictionCount < requiredObservations || contradictionWeight < requiredEvidence) {
        this.clusters.set(key, {
          scores: smoothed,
          identity: previous.identity,
          evidenceWeight,
          observationIds,
          contradictionSpeakerId: rawDecision.identity.id,
          contradictionCount,
          contradictionWeight
        });
        return previous.identity;
      }

      const identity = rawDecision.identity;
      this.clusters.set(key, {
        scores: scores.map(Number),
        identity,
        evidenceWeight: Math.min(20, contradictionWeight),
        observationIds,
        contradictionSpeakerId: null,
        contradictionCount: 0,
        contradictionWeight: 0
      });
      return identity;
    }

    const decision = speakerDecision(smoothed, speakers, options);
    const strongFirstObservation = decision.accepted
      && decision.bestScore >= decision.requiredThreshold + 0.08
      && (decision.scoreGap == null || decision.scoreGap >= decision.requiredMargin + 0.04);
    let identity = decision.accepted && (evidenceWeight >= 2 || strongFirstObservation)
      ? decision.identity
      : null;

    if (previous?.identity) {
      const currentIndex = speakers.findIndex(({ id }) => id === previous.identity.id);
      const releaseThreshold = Number(speakers[currentIndex]?.matchThreshold ?? options.threshold ?? 0.72) - 0.08;
      const currentScore = smoothed[currentIndex];
      const challengerScore = Math.max(...smoothed.filter((_score, index) => index !== currentIndex));
      if (currentIndex >= 0 && currentScore >= releaseThreshold && currentScore + 0.06 >= challengerScore) {
        identity = { ...previous.identity, score: currentScore };
      }
    }

    this.clusters.set(key, {
      scores: smoothed,
      identity,
      evidenceWeight,
      observationIds,
      contradictionSpeakerId: null,
      contradictionCount: 0,
      contradictionWeight: 0
    });
    return identity;
  }

  correct(clusterId, speaker) {
    if (!speaker?.id || !speaker?.name) return null;
    const key = String(clusterId ?? "0");
    const previous = this.clusters.get(key);
    const identity = acceptedSpeakerIdentity(speaker, null, { manual: true });
    this.clusters.set(key, {
      scores: previous?.scores || [], identity, manual: true,
      evidenceWeight: previous?.evidenceWeight || 0,
      observationIds: new Set(previous?.observationIds || []),
      contradictionSpeakerId: null,
      contradictionCount: 0,
      contradictionWeight: 0
    });
    return identity;
  }

  current(clusterId) {
    return this.clusters.get(String(clusterId ?? "0"))?.identity || null;
  }

  hasEvidence(clusterId) {
    return Number(this.clusters.get(String(clusterId ?? "0"))?.evidenceWeight) > 0;
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
    const diarizedIndex = diarizedSpeakerIndex(word?.speaker);
    if (diarizedIndex == null) continue;
    const sourceSpeaker = String(diarizedIndex);
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
  const diarizedIndex = diarizedSpeakerIndex(word?.speaker);
  const sourceSpeaker = diarizedIndex == null ? null : String(diarizedIndex);
  const exactClusterFrames = sourceSpeaker == null ? [] : recognitionFrames.filter((frame) =>
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
    const observationId = candidates.map((frame) => [
      frame.sourceSpeaker ?? "*", Number(frame.start).toFixed(3), Number(frame.end).toFixed(3)
    ].join(":"))
      .sort()
      .join("|");
    const observationWeight = Math.min(8, candidates.reduce((sum, frame) =>
      sum + Math.max(0.25, Number(frame.weight) || 1), 0));
    const known = options.tracker
      ? options.tracker.identify(diarizedIndex, averages, speakers, { ...options, observationId, observationWeight })
      : chooseKnownSpeaker(averages, speakers, options);
    if (known) return {
      label: known.name,
      known: true,
      confidence: known.manual ? null : known.score,
      corrected: Boolean(known.manual),
      ...resolvedIdentityMetadata(known)
    };
  }

  const tracked = diarizedIndex == null ? null : options.tracker?.current(diarizedIndex);
  if (tracked) return {
    label: tracked.name,
    known: true,
    confidence: tracked.manual ? null : tracked.score,
    corrected: Boolean(tracked.manual),
    ...resolvedIdentityMetadata(tracked)
  };
  if (sourceSpeaker != null && options.pendingSpeakerClusters?.has(sourceSpeaker)
    && !options.tracker?.hasEvidence(sourceSpeaker)) {
    return { label: "화자 확인 중", known: false, confidence: null };
  }
  return {
    label: diarizedIndex == null ? "화자 정보 없음" : `미등록 화자 ${alphabeticLabel(diarizedIndex)}`,
    known: false,
    confidence: null
  };
}

export function wordsToSegments(words, recognitionFrames, speakers, options = {}) {
  const segments = [];

  for (const word of Array.isArray(words) ? words : []) {
    const text = String(word?.punctuated_word ?? word?.word ?? "").trim();
    if (!text) continue;
    const identity = resolveWordSpeaker(word, recognitionFrames, speakers, options);
    const diarizedIndex = diarizedSpeakerIndex(word?.speaker);
    const sourceSpeaker = diarizedIndex == null ? null : String(diarizedIndex);
    const start = Number(word.start ?? 0);
    const end = Number(word.end ?? start);
    const wordConfidence = Number(word?.confidence);
    const hasWordConfidence = Number.isFinite(wordConfidence);
    const previous = segments.at(-1);

    if (previous && previous.speaker === identity.label && previous.sourceSpeaker === sourceSpeaker && start - previous.end < 1.25) {
      previous.text += /^[,.!?;:)]/.test(text) ? text : ` ${text}`;
      previous.end = end;
      if (identity.userId != null) previous.userId = identity.userId;
      if (identity.speakerProfileId != null) previous.speakerProfileId = identity.speakerProfileId;
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
      ...(identity.userId != null ? { userId: identity.userId } : {}),
      ...(identity.speakerProfileId != null ? { speakerProfileId: identity.speakerProfileId } : {}),
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
