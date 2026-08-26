import assert from "node:assert/strict";
import test from "node:test";
import { conceptIdFor, normalizeConceptLabel } from "../lib/concept-label.mjs";

test("normalizes labels and derives stable, case-insensitive concept ids", () => {
  assert.equal(normalizeConceptLabel("  임베딩  모델 "), "임베딩 모델");
  assert.equal(conceptIdFor("Embedding"), conceptIdFor("ＥＭＢＥＤＤＩＮＧ"));
  assert.match(conceptIdFor("임베딩"), /^concept_[a-f0-9]{32}$/);
  assert.equal(conceptIdFor("  "), "");
});
