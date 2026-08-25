import { analyzePcmQuality, isSpeakerSignalQuality } from "./audio-quality.mjs";
import { speakerDecision } from "./speaker-matching.mjs";

function segmentPcm(pcm, start, end, sampleRate) {
  const first = Math.max(0, Math.floor((Number(start) || 0) * sampleRate));
  const last = Math.min(pcm.length, Math.ceil((Number(end) || 0) * sampleRate));
  return pcm.subarray(first, last);
}

function combinedClusterPcm(pcm, segments, sampleRate, maximumSeconds) {
  const maximumSamples = Math.max(sampleRate, Math.floor(sampleRate * maximumSeconds));
  const candidates = segments.map((segment) => {
    const audio = segmentPcm(pcm, segment.start, segment.end, sampleRate);
    return { audio, quality: analyzePcmQuality(audio, sampleRate) };
  }).filter(({ audio }) => audio.length);
  const usable = candidates.filter(({ quality }) => isSpeakerSignalQuality(quality));
  const ranked = (usable.length ? usable : candidates).sort((left, right) =>
    right.quality.score - left.quality.score
      || right.quality.voicedRatio - left.quality.voicedRatio
      || right.audio.length - left.audio.length);
  const selected = [];
  let selectedSamples = 0;
  for (const { audio } of ranked) {
    const remaining = maximumSamples - selectedSamples;
    if (remaining <= 0) break;
    const retained = audio.length <= remaining ? audio : audio.subarray(0, remaining);
    selected.push(retained);
    selectedSamples += retained.length;
  }
  if (selectedSamples < sampleRate) return null;
  const combined = new Int16Array(selectedSamples);
  let offset = 0;
  for (const audio of selected) {
    combined.set(audio, offset);
    offset += audio.length;
  }
  return combined;
}

function providerBackedIdentity(sourceSpeaker, speakers) {
  return speakers.find(({ name }) => name === sourceSpeaker) || null;
}

function reconciledIdentity(sourceSpeaker, decision, speakers) {
  const providerIdentity = providerBackedIdentity(sourceSpeaker, speakers);
  if (!providerIdentity) return decision.identity ? { ...decision.identity, source: "local" } : null;
  if (!decision.identity || decision.identity.id === providerIdentity.id) {
    return {
      id: providerIdentity.id,
      name: providerIdentity.name,
      score: decision.identity?.score ?? null,
      source: decision.identity ? "ensemble" : "provider"
    };
  }
  const strongConflict = decision.bestScore >= decision.requiredThreshold + 0.06
    && (decision.scoreGap == null || decision.scoreGap >= decision.requiredMargin + 0.04);
  return strongConflict
    ? { ...decision.identity, source: "local" }
    : { id: providerIdentity.id, name: providerIdentity.name, score: null, source: "provider" };
}

export async function reconcileTranscriptSpeakers(transcript, pcm, speakers, model, options = {}) {
  if (!transcript?.segments?.length || !pcm?.length || !speakers?.length) return transcript;
  const sampleRate = Number(options.sampleRate) || 16_000;
  const grouped = new Map();
  for (const segment of transcript.segments) {
    const list = grouped.get(segment.speaker) || [];
    list.push(segment);
    grouped.set(segment.speaker, list);
  }

  const speakerProfiles = speakers.map(({ profiles, profile }) => profiles || [profile]);
  const identities = new Map();
  for (const [sourceSpeaker, segments] of grouped) {
    const audio = combinedClusterPcm(pcm, segments, sampleRate, Number(options.maximumClusterSeconds) || 12);
    if (!audio) {
      const providerIdentity = providerBackedIdentity(sourceSpeaker, speakers);
      if (providerIdentity) identities.set(sourceSpeaker, { ...providerIdentity, score: null, source: "provider" });
      continue;
    }
    const scores = await model.compare(audio, speakerProfiles, { maximumEmbeddings: 4 });
    if (!scores) {
      const providerIdentity = providerBackedIdentity(sourceSpeaker, speakers);
      if (providerIdentity) identities.set(sourceSpeaker, { ...providerIdentity, score: null, source: "provider" });
      continue;
    }
    const decision = speakerDecision(scores, speakers, options);
    const identity = reconciledIdentity(sourceSpeaker, decision, speakers);
    if (identity) identities.set(sourceSpeaker, identity);
  }

  const segments = transcript.segments.map((segment) => {
    const identity = identities.get(segment.speaker);
    return identity ? { ...segment, speaker: identity.name, known: true, confidence: identity.score } : segment;
  });
  return {
    ...transcript,
    segments,
    speakers: [...new Set(segments.map(({ speaker }) => speaker))]
  };
}
