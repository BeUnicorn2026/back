import assert from "node:assert/strict";
import test from "node:test";
import { buildSttKeyterms } from "../lib/stt-keyterms.mjs";

test("prioritizes speaker names and deduplicates real vocabulary for Nova-3", () => {
  assert.deepEqual(buildSttKeyterms({
    speakerNames: ["민수", "지수"],
    knownTerms: ["벡터 검색", "민수"],
    organizationTerms: [{ term: "임베딩" }, { term: "벡터 검색" }, { term: " " }]
  }), ["민수", "지수", "벡터 검색", "임베딩"]);
});

test("limits keyterms to the provider maximum", () => {
  const terms = buildSttKeyterms({ knownTerms: Array.from({ length: 130 }, (_, index) => `용어 ${index}`) });
  assert.equal(terms.length, 100);
});
