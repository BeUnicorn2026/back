import { analyzePcmQuality } from "./audio-quality.mjs";

export function selectSpeakerReferencePcm(pcm, options = {}) {
  if (!(pcm instanceof Int16Array) || !pcm.length) return new Int16Array();
  const sampleRate = Math.max(1, Math.floor(Number(options.sampleRate) || 16_000));
  const maximumSamples = Math.max(sampleRate * 2, Math.floor(sampleRate * (Number(options.maximumSeconds) || 10)));
  if (pcm.length <= maximumSamples) return pcm;
  const hopSamples = sampleRate;
  const candidates = [];
  for (let start = 0; start + maximumSamples <= pcm.length; start += hopSamples) {
    const window = pcm.subarray(start, start + maximumSamples);
    candidates.push({ start, window, quality: analyzePcmQuality(window, sampleRate) });
  }
  const finalStart = pcm.length - maximumSamples;
  if (!candidates.some(({ start }) => start === finalStart)) {
    const window = pcm.subarray(finalStart);
    candidates.push({ start: finalStart, window, quality: analyzePcmQuality(window, sampleRate) });
  }
  return candidates.sort((left, right) =>
    right.quality.score - left.quality.score
      || right.quality.voicedRatio - left.quality.voicedRatio
      || right.quality.snrDb - left.quality.snrDb
      || left.start - right.start)[0].window;
}
