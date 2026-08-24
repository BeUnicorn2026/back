import assert from "node:assert/strict";
import test from "node:test";
import { aggregateVocabularyTerms } from "../lib/vocabulary-terms.mjs";

test("aggregates only terms extracted from persisted meeting intelligence", () => {
  const terms = aggregateVocabularyTerms([
    {
      meetingId: "meeting-a", updatedAt: "2026-08-23T00:00:00.000Z",
      result: { terms: [{ term: "벡터 검색", definition: "이전 설명", personalizedExplanation: "기획 설명", speaker: "민수", firstSeenAt: 12 }] }
    },
    {
      meetingId: "meeting-b", updatedAt: "2026-08-24T00:00:00.000Z",
      result: { terms: [{ term: "벡터 검색", definition: "최신 설명", personalizedExplanation: "개발 설명", speaker: "지수", firstSeenAt: 4 }] }
    }
  ], ["벡터 검색", "이미 아는 내부 용어"]);

  assert.equal(terms.length, 2);
  assert.deepEqual(terms[0], {
    term: "벡터 검색", definition: "최신 설명", personalizedExplanation: "개발 설명",
    occurrences: 2, meetingCount: 2, firstSeenAt: 4, lastSeenAt: "2026-08-24T00:00:00.000Z",
    speakers: ["민수", "지수"], isKnown: true
  });
  assert.equal(terms[1].term, "이미 아는 내부 용어");
  assert.equal(terms[1].occurrences, 0);
  assert.equal(terms[1].isKnown, true);
});
