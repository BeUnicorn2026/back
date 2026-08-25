import assert from "node:assert/strict";
import test from "node:test";
import { getSpeakerEmbeddingModel, SpeakerEmbeddingModel } from "../lib/speaker-embedding-model.mjs";

test("retries speaker model initialization after a failure instead of caching rejection", async () => {
  const first = getSpeakerEmbeddingModel("/unused", "/definitely-missing/speaker-model-one.onnx");
  await assert.rejects(first, /ENOENT/);

  const second = getSpeakerEmbeddingModel("/unused", "/definitely-missing/speaker-model-two.onnx");
  assert.notStrictEqual(second, first);
  await assert.rejects(second, /speaker-model-two\.onnx/);
});

test("runs inference for clean speech below the stricter enrollment volume", async () => {
  let inferenceCalls = 0;
  const model = new SpeakerEmbeddingModel({
    run: async () => {
      inferenceCalls += 1;
      return { embeddings: { data: new Float32Array([1, 0]) } };
    }
  });
  const pcm = new Int16Array(2 * 16_000);
  for (let index = 0; index < pcm.length * 0.6; index += 1) {
    pcm[index] = Math.round(Math.sin(index / 11) * 300);
  }
  const scores = await model.compare(pcm, [[new Float32Array([1, 0])]]);
  assert.equal(inferenceCalls, 1);
  assert.ok(scores[0] > 0.99);
});
