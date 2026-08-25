const languageCodes = Object.freeze({
  ko: "ko-KR",
  en: "en-US",
  ja: "ja"
});

const numeralsLanguages = new Set(["ko-KR", "en-US"]);

export function buildDeepgramLiveQuery({ language, mode, keyterms = [], sampleRate = 16_000 } = {}) {
  const resolvedLanguage = languageCodes[language] || "ko-KR";
  const resolvedSampleRate = Number.isFinite(Number(sampleRate)) && Number(sampleRate) > 0
    ? Math.floor(Number(sampleRate))
    : 16_000;
  const query = new URLSearchParams({
    model: "nova-3",
    language: resolvedLanguage,
    encoding: "linear16",
    sample_rate: String(resolvedSampleRate),
    channels: "1",
    interim_results: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
    vad_events: "true",
    punctuate: "true",
    smart_format: "true"
  });
  if (numeralsLanguages.has(resolvedLanguage)) query.set("numerals", "true");
  if (mode === "speaker") query.set("diarize_model", "latest");
  for (const keyterm of keyterms) query.append("keyterm", keyterm);
  return query;
}
