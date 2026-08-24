import assert from "node:assert/strict";
import test from "node:test";
import { PcmHistoryBuffer } from "../lib/pcm-history-buffer.mjs";

const pcm = (...samples) => Buffer.from(new Int16Array(samples).buffer);
const values = (buffer) => Array.from(new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2));

test("slices PCM across chunks using absolute sample positions", () => {
  const history = new PcmHistoryBuffer(8);
  history.append(pcm(1, 2, 3));
  history.append(pcm(4, 5, 6));
  assert.deepEqual(values(history.slice(1, 5)), [2, 3, 4, 5]);
  assert.equal(history.earliestSample, 0);
  assert.equal(history.latestSample, 6);
});

test("retains only the configured recent sample window", () => {
  const history = new PcmHistoryBuffer(4);
  history.append(pcm(1, 2, 3));
  history.append(pcm(4, 5, 6));
  assert.equal(history.earliestSample, 2);
  assert.equal(history.latestSample, 6);
  assert.deepEqual(values(history.slice(0, 10)), [3, 4, 5, 6]);
  assert.throws(() => history.append(Buffer.from([1])), /짝수/);
});
