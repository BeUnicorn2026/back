const DEFAULT_SAMPLE_RATE = 16_000;
const FRAME_LENGTH = 400;
const FRAME_SHIFT = 160;
const FFT_SIZE = 512;
const MEL_BINS = 80;
const LOW_FREQUENCY = 20;

const mel = (frequency) => 1127 * Math.log(1 + frequency / 700);
const inverseMel = (value) => 700 * (Math.exp(value / 1127) - 1);

function createMelFilters(sampleRate) {
  const lowMel = mel(LOW_FREQUENCY);
  const highMel = mel(sampleRate / 2);
  const points = Array.from({ length: MEL_BINS + 2 }, (_value, index) =>
    inverseMel(lowMel + (highMel - lowMel) * index / (MEL_BINS + 1)));
  return Array.from({ length: MEL_BINS }, (_value, bin) => {
    const weights = new Float64Array(FFT_SIZE / 2 + 1);
    for (let fftBin = 0; fftBin < weights.length; fftBin += 1) {
      const frequency = fftBin * sampleRate / FFT_SIZE;
      if (frequency < points[bin] || frequency > points[bin + 2]) continue;
      weights[fftBin] = frequency <= points[bin + 1]
        ? (frequency - points[bin]) / (points[bin + 1] - points[bin])
        : (points[bin + 2] - frequency) / (points[bin + 2] - points[bin + 1]);
    }
    return weights;
  });
}

const melFilterCache = new Map();

function melFilters(sampleRate) {
  if (!melFilterCache.has(sampleRate)) melFilterCache.set(sampleRate, createMelFilters(sampleRate));
  return melFilterCache.get(sampleRate);
}

function powerSpectrum(frame) {
  const real = new Float64Array(FFT_SIZE);
  const imaginary = new Float64Array(FFT_SIZE);
  real.set(frame);

  for (let index = 1, reversed = 0; index < FFT_SIZE; index += 1) {
    let bit = FFT_SIZE >> 1;
    while (reversed & bit) {
      reversed ^= bit;
      bit >>= 1;
    }
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
    }
  }

  for (let length = 2; length <= FFT_SIZE; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < FFT_SIZE; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const even = start + offset;
        const odd = even + length / 2;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }

  return Float64Array.from({ length: FFT_SIZE / 2 + 1 }, (_value, index) =>
    real[index] ** 2 + imaginary[index] ** 2);
}

export function computeSpeakerFbank(pcm, sampleRate = DEFAULT_SAMPLE_RATE) {
  if (!(pcm instanceof Int16Array)) throw new TypeError("화자 특징 입력은 Int16Array여야 합니다.");
  if (sampleRate !== DEFAULT_SAMPLE_RATE) throw new Error("화자 특징은 16kHz PCM만 지원합니다.");
  if (pcm.length < FRAME_LENGTH) throw new Error("화자 특징을 계산할 음성이 너무 짧습니다.");

  const frameCount = Math.floor((pcm.length - FRAME_LENGTH) / FRAME_SHIFT) + 1;
  const features = new Float32Array(frameCount * MEL_BINS);
  const means = new Float64Array(MEL_BINS);
  const filters = melFilters(sampleRate);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frame = new Float64Array(FFT_SIZE);
    const start = frameIndex * FRAME_SHIFT;
    let frameMean = 0;
    for (let index = 0; index < FRAME_LENGTH; index += 1) frameMean += pcm[start + index];
    frameMean /= FRAME_LENGTH;

    let previous = pcm[start] - frameMean;
    frame[0] = previous * 0.08;
    for (let index = 1; index < FRAME_LENGTH; index += 1) {
      const current = pcm[start + index] - frameMean;
      const emphasized = current - 0.97 * previous;
      frame[index] = emphasized * (0.54 - 0.46 * Math.cos(2 * Math.PI * index / (FRAME_LENGTH - 1)));
      previous = current;
    }

    const spectrum = powerSpectrum(frame);
    for (let bin = 0; bin < MEL_BINS; bin += 1) {
      let energy = 0;
      const weights = filters[bin];
      for (let fftBin = 0; fftBin < spectrum.length; fftBin += 1) {
        energy += spectrum[fftBin] * weights[fftBin];
      }
      const value = Math.log(Math.max(energy, Number.EPSILON));
      features[frameIndex * MEL_BINS + bin] = value;
      means[bin] += value;
    }
  }

  for (let bin = 0; bin < MEL_BINS; bin += 1) means[bin] /= frameCount;
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    for (let bin = 0; bin < MEL_BINS; bin += 1) {
      features[frameIndex * MEL_BINS + bin] -= means[bin];
    }
  }

  return { data: features, frames: frameCount, bins: MEL_BINS };
}

export const speakerFbankInfo = Object.freeze({
  sampleRate: DEFAULT_SAMPLE_RATE,
  frameLengthSamples: FRAME_LENGTH,
  frameShiftSamples: FRAME_SHIFT,
  fftSize: FFT_SIZE,
  melBins: MEL_BINS,
  window: "hamming",
  cepstralMeanNormalization: true
});
