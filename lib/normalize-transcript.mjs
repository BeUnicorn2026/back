const labelForIndex = (index) => {
  let value = index + 1;
  let label = "";

  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }

  return label;
};

export function normalizeTranscript(payload, options = {}) {
  const sourceSegments = Array.isArray(payload?.segments) ? payload.segments : [];
  const speakerMap = new Map();
  const knownSpeakers = new Set(Array.isArray(options.knownSpeakers) ? options.knownSpeakers : []);
  let generatedLabelCount = 0;

  const segments = sourceSegments
    .filter((segment) => typeof segment?.text === "string" && segment.text.trim())
    .map((segment) => {
      const sourceSpeaker = String(segment.speaker ?? "unknown");
      if (!speakerMap.has(sourceSpeaker)) {
        const shouldPreserve = knownSpeakers.has(sourceSpeaker) || /^[A-Z]+$/.test(sourceSpeaker);
        speakerMap.set(sourceSpeaker, shouldPreserve ? sourceSpeaker : labelForIndex(generatedLabelCount++));
      }

      return {
        id: String(segment.id ?? `segment-${Math.random().toString(36).slice(2)}`),
        speaker: speakerMap.get(sourceSpeaker),
        known: knownSpeakers.has(sourceSpeaker),
        confidence: null,
        start: Number.isFinite(Number(segment.start)) ? Number(segment.start) : 0,
        end: Number.isFinite(Number(segment.end)) ? Number(segment.end) : 0,
        text: segment.text.trim(),
        transcriptConfidence: Number.isFinite(Number(segment.confidence)) ? Number(segment.confidence) : null
      };
    });

  return {
    text: typeof payload?.text === "string" ? payload.text : segments.map(({ text }) => text).join(" "),
    duration: Number.isFinite(Number(payload?.duration)) ? Number(payload.duration) : 0,
    speakers: [...new Set(segments.map(({ speaker }) => speaker))],
    segments
  };
}
