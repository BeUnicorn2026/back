export class SpeakerAudioAccumulator {
  constructor(options = {}) {
    this.sampleRate = Math.max(1, Math.floor(Number(options.sampleRate) || 16_000));
    this.minimumSamples = Math.max(this.sampleRate, Math.floor(this.sampleRate * (Number(options.minimumSeconds) || 1.5)));
    this.analysisIntervalSamples = Math.max(
      Math.floor(this.sampleRate / 4),
      Math.floor(this.sampleRate * (Number(options.analysisIntervalSeconds) || 0.75))
    );
    this.maximumSamples = Math.max(this.minimumSamples, Math.floor(this.sampleRate * (Number(options.maximumSeconds) || 6)));
    this.clusters = new Map();
  }

  add(clusterId, pcm, timing = {}) {
    if (!(pcm instanceof Int16Array) || !pcm.length || clusterId == null) return null;
    const key = String(clusterId);
    const start = Math.max(0, Number(timing.start) || 0);
    const end = Math.max(start, Number(timing.end) || start + pcm.length / this.sampleRate);
    const previous = this.clusters.get(key);
    const overlapSamples = previous
      ? Math.max(0, Math.min(pcm.length, Math.ceil((previous.lastEnd - start) * this.sampleRate)))
      : 0;
    const fresh = pcm.subarray(overlapSamples);
    if (!fresh.length) return null;

    const freshSamples = Math.min(fresh.length, this.maximumSamples);
    const retained = Math.min(previous?.pcm.length || 0, this.maximumSamples - freshSamples);
    const combined = new Int16Array(retained + freshSamples);
    if (retained) combined.set(previous.pcm.subarray(previous.pcm.length - retained), 0);
    combined.set(fresh.subarray(fresh.length - freshSamples), retained);
    const newSamplesSinceAnalysis = (previous?.newSamplesSinceAnalysis || 0) + fresh.length;
    const state = { pcm: combined, lastEnd: Math.max(previous?.lastEnd || 0, end), newSamplesSinceAnalysis };
    this.clusters.set(key, state);

    if (combined.length < this.minimumSamples || newSamplesSinceAnalysis < this.analysisIntervalSamples) return null;
    state.newSamplesSinceAnalysis = 0;
    return {
      pcm: combined,
      accumulatedSeconds: combined.length / this.sampleRate,
      newEvidenceSeconds: newSamplesSinceAnalysis / this.sampleRate
    };
  }
}
