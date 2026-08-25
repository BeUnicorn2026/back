import assert from "node:assert/strict";
import test from "node:test";
import {
  KnowledgeExplanationService, knowledgeExplanationCacheKey, safetyIdentifierFor
} from "../lib/knowledge-explanation.mjs";

test("generates a safe local explanation with a context rewrite and deterministic cache identity", async () => {
  const service = new KnowledgeExplanationService();
  const result = await service.generate({
    userId: "user-a", term: "임베딩", definition: "의미를 수치 벡터로 표현한 값",
    context: "이번 회의에서 임베딩을 도입하기로 했다", introduction: "신입 기획자입니다", level: "simple"
  });
  assert.equal(result.source, "local");
  assert.match(result.explanation, /^쉽게 말하면/);
  assert.match(result.rewrittenContext, /임베딩/);
  assert.equal(result.choices.length, 3);
  const base = { term: "임베딩", definition: "정의", context: "문맥", level: "simple" };
  const left = knowledgeExplanationCacheKey({ ...base, introduction: "기획자입니다" });
  const right = knowledgeExplanationCacheKey({ ...base, introduction: "기획자입니다" });
  const other = knowledgeExplanationCacheKey({ ...base, introduction: "개발자입니다" });
  assert.equal(left, right);
  assert.notEqual(left, other);
  assert.equal(safetyIdentifierFor("user-a").length, 32);
});

test("leaves the context rewrite empty when no meeting sentence is available", async () => {
  const service = new KnowledgeExplanationService();
  const result = await service.generate({
    userId: "user-a", term: "VAD", definition: "음성 구간 감지", level: "simple"
  });
  assert.equal(result.rewrittenContext, "");
});

test("sends only minimized structured input and does not store provider responses", async () => {
  let request;
  const service = new KnowledgeExplanationService({
    apiKey: "test-key",
    model: "test-model",
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify({
          explanation: "쉬운 설명", rewrittenContext: "회의에서 임베딩(의미를 숫자로 바꾼 값)을 도입하기로 했다는 뜻입니다.",
          analogy: "지도 좌표와 비슷합니다.",
          checkQuestion: "임베딩은 무엇인가요?", choices: ["벡터 표현", "일정", "화자명"],
          correctChoiceIndex: 0, answerRationale: "의미를 벡터로 표현합니다."
        }) }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  const result = await service.generate({
    userId: "private-user", term: "임베딩", definition: "의미 벡터", context: "회의 발화",
    introduction: "디자인 팀 신입입니다", level: "standard"
  });
  assert.equal(result.source, "openai");
  assert.match(result.rewrittenContext, /뜻입니다/);
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, "json_schema");
  assert.deepEqual(Object.keys(JSON.parse(request.input)), ["term", "definition", "context", "introduction", "level"]);
  assert.equal(JSON.parse(request.input).introduction, "디자인 팀 신입입니다");
  assert.notEqual(request.safety_identifier, "private-user");
  assert.equal(JSON.stringify(request).includes("pKnown"), false);
});

test("rejects malformed quiz output instead of teaching an unverifiable answer", async () => {
  const service = new KnowledgeExplanationService({
    apiKey: "test-key",
    fetch: async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({
        explanation: "설명", analogy: "비유", checkQuestion: "질문", choices: ["하나"],
        correctChoiceIndex: 9, answerRationale: "근거"
      }) }] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });
  await assert.rejects(service.generate({ userId: "u", term: "VAD", definition: "음성 구간 감지" }), /형식/);
});
