import assert from "node:assert/strict";
import test from "node:test";
import { getSpeakerEmbeddingModel } from "../lib/speaker-embedding-model.mjs";

test("retries speaker model initialization after a failure instead of caching rejection", async () => {
  const first = getSpeakerEmbeddingModel("/unused", "/definitely-missing/speaker-model-one.onnx");
  await assert.rejects(first, /ENOENT/);

  const second = getSpeakerEmbeddingModel("/unused", "/definitely-missing/speaker-model-two.onnx");
  assert.notStrictEqual(second, first);
  await assert.rejects(second, /speaker-model-two\.onnx/);
});
