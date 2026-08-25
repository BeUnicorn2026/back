import assert from "node:assert/strict";
import test from "node:test";
import { personalizeKnowledgeTerms } from "../lib/knowledge-personalization.mjs";
import { conceptIdFor } from "../lib/knowledge-twin.mjs";

test("joins shared terms with only the requesting user's knowledge state", () => {
  const terms = [
    { term: "임베딩", definition: "의미를 수치 벡터로 표현한 값", occurrences: 3 },
    { term: "VAD", definition: "음성 구간 감지", occurrences: 1 }
  ];
  const states = [
    { conceptId: conceptIdFor("임베딩"), pKnown: 0.08, confidence: 0.7, status: "unknown", evidenceCount: 2, explicitEvidenceCount: 1, source: "evidence" },
    { conceptId: conceptIdFor("VAD"), pKnown: 0.92, confidence: 0.7, status: "known", evidenceCount: 1, explicitEvidenceCount: 1, source: "evidence" }
  ];
  const result = personalizeKnowledgeTerms(terms, states);
  assert.equal(result[0].term, "임베딩");
  assert.equal(result[0].shouldExplain, true);
  assert.match(result[0].personalizedExplanation, /^현재 회의 맥락에서 보면/);
  assert.match(result[0].personalizedExplanation, /쉽게 말해/);
  assert.equal(result[1].isKnown, true);
  assert.equal(result[1].shouldExplain, false);
  assert.equal("logOdds" in result[0].knowledge, false);
});

test("frames every explanation neutrally and ignores any legacy role argument", () => {
  const terms = [{ term: "임베딩", definition: "의미를 수치 벡터로 표현한 값", occurrences: 3 }];
  const states = [
    { conceptId: conceptIdFor("임베딩"), pKnown: 0.08, confidence: 0.7, status: "unknown", evidenceCount: 2, explicitEvidenceCount: 1, source: "evidence" }
  ];
  const withoutRole = personalizeKnowledgeTerms(terms, states);
  const withLegacyRole = personalizeKnowledgeTerms(terms, states, ["디자인"]);
  assert.match(withoutRole[0].personalizedExplanation, /^현재 회의 맥락에서 보면/);
  assert.equal(withoutRole[0].personalizedExplanation, withLegacyRole[0].personalizedExplanation);
});
