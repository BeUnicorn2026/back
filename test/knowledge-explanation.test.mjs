import assert from "node:assert/strict";
import test from "node:test";
import {
  KnowledgeExplanationService, knowledgeExplanationCacheKey, safetyIdentifierFor
} from "../lib/knowledge-explanation.mjs";

test("generates a safe local explanation and deterministic cache identity", async () => {
  const service = new KnowledgeExplanationService();
  const result = await service.generate({
    userId: "user-a", term: "임베딩", definition: "의미를 수치 벡터로 표현한 값", level: "simple"
  });
  assert.equal(result.source, "local");
  assert.match(result.explanation, /^쉽게 말하면/);
  assert.equal(result.choices.length, 3);
  const left = knowledgeExplanationCacheKey({ term: "임베딩", definition: "정의", roles: ["개발", "기획"], level: "simple" });
  const right = knowledgeExplanationCacheKey({ term: "임베딩", definition: "정의", roles: ["기획", "개발"], level: "simple" });
  assert.equal(left, right);
  assert.equal(safetyIdentifierFor("user-a").length, 32);
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
          explanation: "디자인 관점 설명", analogy: "지도 좌표와 비슷합니다.",
          checkQuestion: "임베딩은 무엇인가요?", choices: ["벡터 표현", "일정", "화자명"],
          correctChoiceIndex: 0, answerRationale: "의미를 벡터로 표현합니다."
        }) }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  const result = await service.generate({
    userId: "private-user", term: "임베딩", definition: "의미 벡터", context: "회의 발화", roles: ["디자인"], level: "standard"
  });
  assert.equal(result.source, "openai");
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, "json_schema");
  assert.deepEqual(Object.keys(JSON.parse(request.input)), ["term", "definition", "context", "roles", "level"]);
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
