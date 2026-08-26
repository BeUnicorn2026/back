import assert from "node:assert/strict";
import test from "node:test";
import {
  KnowledgeFilterService, normalizeTermKey, personalizeKnowledgeTerms
} from "../lib/knowledge-personalization.mjs";

test("normalizeTermKey merges spacing, case, and joiner variants of the same term", () => {
  assert.equal(normalizeTermKey("Fine-Tuning"), normalizeTermKey("fine tuning"));
  assert.equal(normalizeTermKey("파인 튜닝"), normalizeTermKey("파인튜닝"));
  assert.equal(normalizeTermKey("A_B·C"), "abc");
  assert.notEqual(normalizeTermKey("임베딩"), normalizeTermKey("인베딩"));
});

test("fail-open: with no filter information every term is exposed", () => {
  const terms = [
    { term: "임베딩", definition: "의미를 수치 벡터로 표현한 값", occurrences: 3 },
    { term: "VAD", definition: "음성 구간 감지", occurrences: 1 }
  ];
  const result = personalizeKnowledgeTerms(terms, { familiarKeys: new Set(), knownTerms: [], source: "fail_open" });
  assert.equal(result.length, 2);
  for (const entry of result) {
    assert.equal(entry.isKnown, false);
    assert.equal(entry.shouldExplain, true);
    assert.equal(entry.knowledge.status, "unknown");
    assert.equal(entry.knowledge.source, "fail_open");
  }
  assert.ok(result[0].personalizedExplanation.length > 0);
});

test("introduction-based familiar terms are hidden and sorted after visible ones", () => {
  const terms = [
    { term: "임베딩", definition: "의미 벡터", occurrences: 1 },
    { term: "파인튜닝", definition: "추가 학습", occurrences: 5 }
  ];
  const result = personalizeKnowledgeTerms(terms, {
    familiarKeys: new Set([normalizeTermKey("임베딩")]),
    knownTerms: []
  });
  assert.equal(result[0].term, "파인튜닝");
  assert.equal(result[0].shouldExplain, true);
  assert.equal(result[1].term, "임베딩");
  assert.equal(result[1].isKnown, true);
  assert.equal(result[1].shouldExplain, false);
  assert.equal(result[1].knowledge.source, "introduction");
});

test("explicit knownTerms beat everything and match across notation variants", () => {
  const terms = [{ term: "Fine-Tuning", definition: "추가 학습", occurrences: 2 }];
  const result = personalizeKnowledgeTerms(terms, {
    familiarKeys: new Set(),
    knownTerms: ["파인튜닝", "fine tuning"]
  });
  assert.equal(result[0].isKnown, true);
  assert.equal(result[0].knowledge.source, "explicit");
});

test("local mode (no API key) fails open with an empty familiar set", async () => {
  const service = new KnowledgeFilterService();
  assert.equal(service.mode, "local");
  const result = await service.familiarTerms({
    userId: "u", introduction: "데이터 연구자입니다", candidateTerms: ["임베딩"]
  });
  assert.equal(result.familiarKeys.size, 0);
  assert.equal(result.source, "local");
});

test("empty introduction skips the LLM entirely and exposes everything", async () => {
  let called = false;
  const service = new KnowledgeFilterService({ apiKey: "test-key", fetch: async () => { called = true; } });
  const result = await service.familiarTerms({ userId: "u", introduction: "  ", candidateTerms: ["임베딩"] });
  assert.equal(called, false);
  assert.equal(result.familiarKeys.size, 0);
  assert.equal(result.source, "no_introduction");
});

function openaiResponse(understoodTerms) {
  return new Response(JSON.stringify({
    output: [{ content: [{ type: "output_text", text: JSON.stringify({ understood_terms: understoodTerms, refined_glossary: [] }) }] }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("uses the paper's A.2 prompt with glossary, profile, and preference list", async () => {
  let request;
  const service = new KnowledgeFilterService({
    apiKey: "test-key",
    model: "test-model",
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return openaiResponse(["SLA"]);
    }
  });
  const result = await service.familiarTerms({
    userId: "private-user",
    introduction: "저는 스타트업 CEO입니다.",
    candidateTerms: [
      { term: "SLA", definition: "서비스 수준 계약입니다." },
      { term: "온프레미스", definition: "자체 서버 운영 방식입니다." }
    ],
    knownTerms: ["ARR"]
  });
  assert.match(request.instructions, /^You are given a glossary, a user profile, and a user preference list\./);
  assert.match(request.instructions, /understood_terms/);
  assert.match(request.input, /^Glossary: \[/);
  assert.ok(request.input.includes('{"SLA":"서비스 수준 계약입니다."}'));
  assert.ok(request.input.includes("User Profile: 저는 스타트업 CEO입니다."));
  assert.ok(request.input.includes('User preference: ["ARR"]'));
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 1000);
  assert.equal("text" in request, false);
  assert.notEqual(request.safety_identifier, "private-user");
  assert.ok(result.familiarKeys.has(normalizeTermKey("SLA")));
  assert.equal(result.familiarKeys.has(normalizeTermKey("온프레미스")), false);
  assert.equal(result.source, "openai");
});

test("plain string candidates are still accepted", async () => {
  const service = new KnowledgeFilterService({
    apiKey: "test-key",
    fetch: async () => openaiResponse(["임베딩"])
  });
  const result = await service.familiarTerms({
    userId: "u", introduction: "데이터 연구자입니다", candidateTerms: ["임베딩", "VAD"]
  });
  assert.ok(result.familiarKeys.has(normalizeTermKey("임베딩")));
});

test("hallucinated terms outside the candidate list are silently dropped", async () => {
  const service = new KnowledgeFilterService({
    apiKey: "test-key",
    fetch: async () => openaiResponse(["임베딩", "블록체인"])
  });
  const result = await service.familiarTerms({
    userId: "u", introduction: "데이터 연구자입니다", candidateTerms: ["임베딩"]
  });
  assert.ok(result.familiarKeys.has(normalizeTermKey("임베딩")));
  assert.equal(result.familiarKeys.has(normalizeTermKey("블록체인")), false);
  assert.equal(result.familiarKeys.size, 1);
});

test("fail-open on HTTP errors and on a rejected fetch", async () => {
  const failing = new KnowledgeFilterService({
    apiKey: "test-key",
    fetch: async () => new Response("{}", { status: 500 })
  });
  const httpResult = await failing.familiarTerms({
    userId: "u", introduction: "기획자입니다", candidateTerms: ["임베딩"]
  });
  assert.equal(httpResult.familiarKeys.size, 0);
  assert.equal(httpResult.source, "fail_open");

  const throwing = new KnowledgeFilterService({
    apiKey: "test-key",
    fetch: async () => { throw new Error("network down"); }
  });
  const thrownResult = await throwing.familiarTerms({
    userId: "u", introduction: "기획자입니다", candidateTerms: ["임베딩"]
  });
  assert.equal(thrownResult.familiarKeys.size, 0);
  assert.equal(thrownResult.source, "fail_open");
});

test("caches by introduction and candidate set so repeat views skip the LLM", async () => {
  let calls = 0;
  const service = new KnowledgeFilterService({
    apiKey: "test-key",
    fetch: async () => {
      calls += 1;
      return openaiResponse(["임베딩"]);
    }
  });
  const input = { userId: "u", introduction: "데이터 연구자입니다", candidateTerms: ["임베딩", "VAD"] };
  const first = await service.familiarTerms(input);
  const second = await service.familiarTerms(input);
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
  assert.deepEqual([...second.familiarKeys], [...first.familiarKeys]);

  const other = await service.familiarTerms({ ...input, introduction: "재무 담당입니다" });
  assert.equal(calls, 2);
  assert.equal(other.source, "openai");

  // 아는 용어 목록(User preference)이 달라져도 캐시를 공유하지 않는다.
  const withPreference = await service.familiarTerms({ ...input, knownTerms: ["VAD"] });
  assert.equal(calls, 3);
  assert.equal(withPreference.source, "openai");
});

test("failed calls are not cached, so the next request retries", async () => {
  let calls = 0;
  const service = new KnowledgeFilterService({
    apiKey: "test-key",
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response("{}", { status: 502 });
      return openaiResponse(["임베딩"]);
    }
  });
  const input = { userId: "u", introduction: "데이터 연구자입니다", candidateTerms: ["임베딩"] };
  const first = await service.familiarTerms(input);
  assert.equal(first.source, "fail_open");
  const second = await service.familiarTerms(input);
  assert.equal(second.source, "openai");
  assert.equal(calls, 2);
});
