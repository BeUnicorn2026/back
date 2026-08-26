import assert from "node:assert/strict";
import test from "node:test";
import {
  KnowledgeExplanationService, knowledgeExplanationCacheKey, safetyIdentifierFor,
  containingSentence, koreanParticleFor, reconstructSentence
} from "../lib/knowledge-explanation.mjs";

test("extracts the sentence that contains the clicked term, tolerating inflection", () => {
  assert.equal(
    containingSentence("첫 문장이다. 이번 회의에서 임베딩을 도입한다. 끝.", "임베딩"),
    "이번 회의에서 임베딩을 도입한다."
  );
  assert.equal(containingSentence("화자 인식을 껐다.", "임베딩"), "화자 인식을 껐다.");
  assert.equal(containingSentence("", "임베딩"), "");
});

test("selects the correct particle for the word it now attaches to", () => {
  assert.equal(koreanParticleFor("값", "을/를"), "을");
  assert.equal(koreanParticleFor("터", "을/를"), "를");
  assert.equal(koreanParticleFor("값", "은/는"), "은");
  assert.equal(koreanParticleFor("터", "은/는"), "는");
  assert.equal(koreanParticleFor("값", "이/가"), "이");
  assert.equal(koreanParticleFor("터", "이/가"), "가");
  assert.equal(koreanParticleFor("값", "과/와"), "과");
  assert.equal(koreanParticleFor("터", "과/와"), "와");
  assert.equal(koreanParticleFor("값", "으로/로"), "으로");
  assert.equal(koreanParticleFor("물", "으로/로"), "로");
  assert.equal(koreanParticleFor("터", "으로/로"), "로");
});

test("reconstructs a sentence by swapping only the term and repairing its particle", () => {
  assert.equal(
    reconstructSentence("이번 회의에서 임베딩을 도입하기로 했다.", "임베딩", "의미를 수치 벡터로 표현한 값"),
    "이번 회의에서 의미를 수치 벡터로 표현한 값을 도입하기로 했다."
  );
  assert.equal(reconstructSentence("화자 인식을 껐다.", "임베딩", "쉬운 말"), "");
});

test("locally rebuilds the sentence by replacing the difficult term, not defining it", async () => {
  const service = new KnowledgeExplanationService();
  const result = await service.generate({
    userId: "user-a", term: "임베딩", definition: "의미를 수치 벡터로 표현한 값",
    context: "이번 회의에서 임베딩을 도입하기로 했다.", introduction: "신입 기획자입니다", level: "simple"
  });
  assert.equal(result.source, "local");
  assert.match(result.explanation, /^쉽게 말하면/);
  assert.equal(result.originalSentence, "이번 회의에서 임베딩을 도입하기로 했다.");
  assert.equal(result.rewrittenContext.includes("임베딩"), false);
  assert.notEqual(result.rewrittenContext, result.originalSentence);
  assert.match(result.rewrittenContext, /도입하기로 했다/);
  assert.equal(result.contextRepaired, true);

  const base = { term: "임베딩", definition: "정의", context: "문맥", level: "simple" };
  const left = knowledgeExplanationCacheKey({ ...base, introduction: "기획자입니다" });
  const right = knowledgeExplanationCacheKey({ ...base, introduction: "기획자입니다" });
  const other = knowledgeExplanationCacheKey({ ...base, introduction: "개발자입니다" });
  assert.equal(left, right);
  assert.notEqual(left, other);
  assert.equal(safetyIdentifierFor("user-a").length, 32);
});

test("leaves the rewritten sentence empty when no meeting sentence is available", async () => {
  const service = new KnowledgeExplanationService();
  const result = await service.generate({
    userId: "user-a", term: "VAD", definition: "음성 구간 감지", level: "simple"
  });
  assert.equal(result.rewrittenContext, "");
  assert.equal(result.originalSentence, "");
});

test("sends only the containing sentence and does not store provider responses", async () => {
  let request;
  const service = new KnowledgeExplanationService({
    apiKey: "test-key",
    model: "test-model",
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify({
          explanation: "쉬운 설명", rewrittenContext: "이번 회의에서 의미를 숫자로 바꾼 값을 도입하기로 했다.",
          analogy: "지도 좌표와 비슷합니다."
        }) }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  const result = await service.generate({
    userId: "private-user", term: "임베딩", definition: "의미 벡터",
    context: "지난주에 회의를 했다. 이번 회의에서 임베딩을 도입하기로 했다.",
    introduction: "디자인 팀 신입입니다", level: "standard"
  });
  assert.equal(result.source, "openai");
  assert.equal(result.rewrittenContext.includes("임베딩"), false);
  assert.equal(result.originalSentence, "이번 회의에서 임베딩을 도입하기로 했다.");
  assert.equal(JSON.parse(request.input).context, "이번 회의에서 임베딩을 도입하기로 했다.");
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, "json_schema");
  assert.deepEqual(Object.keys(JSON.parse(request.input)), ["term", "definition", "context", "level"]);
  assert.equal(JSON.parse(request.input).introduction, undefined);
  assert.equal(request.instructions.includes("디자인 팀 신입입니다"), true);
  assert.notEqual(request.safety_identifier, "private-user");
  assert.equal(JSON.stringify(request).includes("pKnown"), false);
});

test("repairs a model rewrite that leaves the difficult term in place", async () => {
  const service = new KnowledgeExplanationService({
    apiKey: "test-key",
    fetch: async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({
        explanation: "설명", rewrittenContext: "이번 회의에서 임베딩(어려운 말)을 도입하기로 했다.",
        analogy: "비유"
      }) }] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });
  const result = await service.generate({
    userId: "u", term: "임베딩", definition: "의미 벡터",
    context: "이번 회의에서 임베딩을 도입하기로 했다.", level: "standard"
  });
  assert.equal(result.rewrittenContext.includes("임베딩"), false);
  assert.notEqual(result.rewrittenContext, result.originalSentence);
  assert.equal(result.contextRepaired, true);
});

test("ignores legacy quiz fields a model might still emit", async () => {
  const service = new KnowledgeExplanationService({
    apiKey: "test-key",
    fetch: async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({
        explanation: "설명", rewrittenContext: "", analogy: "비유",
        checkQuestion: "질문", choices: ["하나", "둘", "셋"], correctChoiceIndex: 0, answerRationale: "근거"
      }) }] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });
  const result = await service.generate({ userId: "u", term: "VAD", definition: "음성 구간 감지" });
  assert.equal("checkQuestion" in result, false);
  assert.equal("choices" in result, false);
  assert.equal("correctChoiceIndex" in result, false);
  assert.equal("answerRationale" in result, false);
});
