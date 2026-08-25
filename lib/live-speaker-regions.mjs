export function speakerRegionSampleRange(region, audioHistory, sampleRate = 16_000) {
  const rate = Math.max(1, Math.floor(Number(sampleRate) || 16_000));
  const earliestSample = Math.max(0, Math.floor(Number(audioHistory?.earliestSample) || 0));
  const latestSample = Math.max(earliestSample, Math.floor(Number(audioHistory?.latestSample) || earliestSample));
  const start = Math.max(0, Number(region?.start) || 0);
  const end = Math.max(start, Number(region?.end) || start);
  const firstSample = Math.max(earliestSample, Math.floor(start * rate));
  const lastSample = Math.min(latestSample, Math.ceil(end * rate));
  return lastSample > firstSample ? { firstSample, lastSample } : null;
}
