const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) {
    const value = sample / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

const toDbfs = (value) => value > 0 ? 20 * Math.log10(value) : -100;

export function analyzePcmQuality(pcm, sampleRate = 16_000) {
  if (!(pcm instanceof Int16Array) || !pcm.length) {
    return {
      duration: 0, rms: 0, rmsDbfs: -100, peak: 0, peakDbfs: -100,
      voicedRatio: 0, clippingRatio: 0, noiseFloorDbfs: -100, snrDb: 0,
      score: 0, usable: false, warnings: ["오디오가 비어 있습니다."]
    };
  }

  const frameSamples = Math.max(1, Math.round(sampleRate * 0.02));
  const frameRms = [];
  let peak = 0;
  let clipped = 0;
  for (const sample of pcm) {
    const absolute = Math.abs(sample / 32768);
    peak = Math.max(peak, absolute);
    if (absolute >= 0.98) clipped += 1;
  }
  for (let start = 0; start < pcm.length; start += frameSamples) {
    frameRms.push(rms(pcm.subarray(start, Math.min(start + frameSamples, pcm.length))));
  }

  const overallRms = rms(pcm);
  const noiseFloor = percentile(frameRms, 0.2);
  const speechThreshold = Math.max(0.006, noiseFloor * 2.8);
  const voicedFrames = frameRms.filter((value) => value >= speechThreshold);
  const voicedRatio = voicedFrames.length / frameRms.length;
  const speechRms = voicedFrames.length
    ? Math.sqrt(voicedFrames.reduce((sum, value) => sum + value * value, 0) / voicedFrames.length)
    : 0;
  const snrDb = clamp(20 * Math.log10(Math.max(speechRms, 0.000001) / Math.max(noiseFloor, 0.0001)), 0, 60);
  const clippingRatio = clipped / pcm.length;
  const duration = pcm.length / sampleRate;
  const warnings = [];
  if (overallRms < 0.012) warnings.push("등록 음성이 작습니다. 마이크를 가까이 두고 조금 더 크게 말해 주세요.");
  if (voicedRatio < 0.35) warnings.push("말소리 구간이 짧습니다. 침묵을 줄이고 연속해서 말해 주세요.");
  if (snrDb < 15) warnings.push("배경 소음이 큽니다. 더 조용한 환경에서 다시 녹음해 주세요.");
  if (clippingRatio > 0.005) warnings.push("소리가 찌그러질 정도로 큽니다. 마이크 입력 레벨을 낮춰 주세요.");

  const score = Math.round(clamp(
    100
      - Math.max(0, 0.012 - overallRms) * 2_000
      - Math.max(0, 0.35 - voicedRatio) * 90
      - Math.max(0, 15 - snrDb) * 2
      - Math.max(0, clippingRatio - 0.005) * 1_500,
    0,
    100
  ));
  const usable = duration >= 5 && overallRms >= 0.008 && voicedRatio >= 0.18 && snrDb >= 7 && clippingRatio <= 0.03;

  return {
    duration,
    rms: overallRms,
    rmsDbfs: toDbfs(overallRms),
    peak,
    peakDbfs: toDbfs(peak),
    voicedRatio,
    clippingRatio,
    noiseFloorDbfs: toDbfs(noiseFloor),
    snrDb,
    score,
    usable,
    warnings
  };
}

export function isSpeakerInferenceQuality(quality) {
  return Number(quality?.duration) >= 1 && isSpeakerSignalQuality(quality);
}

export function isSpeakerSignalQuality(quality) {
  return Number(quality?.rms) >= 0.008
    && Number(quality?.voicedRatio) >= 0.18
    && Number(quality?.snrDb) >= 7
    && Number(quality?.clippingRatio) <= 0.03;
}
