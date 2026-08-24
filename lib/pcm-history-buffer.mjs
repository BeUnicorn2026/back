export class PcmHistoryBuffer {
  constructor(maximumSamples) {
    this.maximumSamples = Math.max(1, Math.floor(Number(maximumSamples) || 1));
    this.chunks = [];
    this.totalSamples = 0;
  }

  get earliestSample() {
    return this.chunks[0]?.start ?? this.totalSamples;
  }

  get latestSample() {
    return this.totalSamples;
  }

  append(value) {
    const buffer = Buffer.from(value);
    if (buffer.byteLength % 2) throw new Error("16-bit PCM 데이터 길이는 짝수여야 합니다.");
    if (!buffer.length) return;
    const start = this.totalSamples;
    const end = start + buffer.byteLength / 2;
    this.chunks.push({ start, end, buffer });
    this.totalSamples = end;
    this.#trim();
  }

  #trim() {
    const minimum = Math.max(0, this.totalSamples - this.maximumSamples);
    while (this.chunks.length && this.chunks[0].end <= minimum) this.chunks.shift();
    const first = this.chunks[0];
    if (first && first.start < minimum) {
      const byteOffset = (minimum - first.start) * 2;
      first.buffer = first.buffer.subarray(byteOffset);
      first.start = minimum;
    }
  }

  slice(firstSample, lastSample) {
    const first = Math.max(this.earliestSample, Math.floor(Number(firstSample) || 0));
    const last = Math.min(this.latestSample, Math.ceil(Number(lastSample) || 0));
    if (last <= first) return Buffer.alloc(0);
    const parts = [];
    for (const chunk of this.chunks) {
      if (chunk.end <= first) continue;
      if (chunk.start >= last) break;
      const startByte = Math.max(0, first - chunk.start) * 2;
      const endByte = Math.min(chunk.end, last) - chunk.start;
      parts.push(chunk.buffer.subarray(startByte, endByte * 2));
    }
    return Buffer.concat(parts);
  }
}
