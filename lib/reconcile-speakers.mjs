import { chooseKnownSpeaker } from "./speaker-matching.mjs";

function segmentPcm(pcm, start, end, sampleRate) {
  const first = Math.max(0, Math.floor((Number(start) || 0) * sampleRate));
  const last = Math.min(pcm.length, Math.ceil((Number(end) || 0) * sampleRate));
  return pcm.subarray(first, last);
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
    const observations = [];
    for (const segment of segments.slice(0, 8)) {
      const audio = segmentPcm(pcm, Math.max(0, segment.start - 0.12), segment.end + 0.12, sampleRate);
      if (audio.length < sampleRate) continue;
      const scores = await model.compare(audio, speakerProfiles, { maximumEmbeddings: 2 });
      if (scores) observations.push({ scores, weight: Math.min(6, audio.length / sampleRate) });
    }
    if (!observations.length) continue;
    const averages = speakers.map((_speaker, index) => {
      const totalWeight = observations.reduce((sum, observation) => sum + observation.weight, 0);
      return observations.reduce((sum, observation) => sum + observation.scores[index] * observation.weight, 0) / totalWeight;
    });
    const identity = chooseKnownSpeaker(averages, speakers, options);
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
