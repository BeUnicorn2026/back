import assert from "node:assert/strict";
import test from "node:test";
import { selectSpeakerReferencePcm } from "../lib/speaker-reference.mjs";

test("keeps known-speaker references within the API ten second limit", () => {
  const pcm = new Int16Array(18 * 16_000);
  for (let index = 8 * 16_000; index < pcm.length; index += 1) {
    pcm[index] = Math.round(Math.sin(index / 11) * 5_000);
  }
  const selected = selectSpeakerReferencePcm(pcm);
  assert.equal(selected.length, 10 * 16_000);
  assert.ok(selected.some((sample) => sample !== 0));
  assert.notEqual(selected.byteOffset, pcm.byteOffset);
});

test("preserves valid short references and rejects empty input", () => {
  const pcm = new Int16Array(5 * 16_000).fill(200);
  assert.equal(selectSpeakerReferencePcm(pcm), pcm);
  assert.equal(selectSpeakerReferencePcm(null).length, 0);
});
