import assert from "node:assert/strict";
import test from "node:test";
import {
  PersonalizedTranscriptService,
  personalizedTranscriptCacheKey
} from "../lib/personalized-transcript.mjs";

test("personalized transcript cache is stable and changes with the learner introduction", () => {
  const base = { text: "DB에 저장해 주세요.", model: "openai:test" };
  assert.equal(
    personalizedTranscriptCacheKey({ ...base, introduction: "디자이너입니다." }),
    personalizedTranscriptCacheKey({ ...base, introduction: "디자이너입니다." })
  );
  assert.notEqual(
    personalizedTranscriptCacheKey({ ...base, introduction: "디자이너입니다." }),
    personalizedTranscriptCacheKey({ ...base, introduction: "백엔드 개발자입니다." })
  );
});

test("local mode preserves the verified transcript", async () => {
  const service = new PersonalizedTranscriptService();
  const result = await service.translate({
    userId: "user-a",
    introduction: "제품 디자이너입니다.",
    items: [{ id: "3", text: "DB에 저장해 주세요." }]
  });
  assert.equal(result.source, "local");
  assert.deepEqual(result.translations, [{
    id: "3",
    originalText: "DB에 저장해 주세요.",
    personalizedText: "DB에 저장해 주세요.",
    changed: false
  }]);
});

test("OpenAI mode keeps the introduction in guarded instructions and returns every speech by id", async () => {
  let request;
  const service = new PersonalizedTranscriptService({
    apiKey: "test-key",
    model: "test-model",
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({
        output: [{ content: [{ type: "output_text", text: JSON.stringify({
          translations: [
            { id: "4", text: "데이터를 정리해 보관하는 공간에 저장해 주세요." },
            { id: "5", text: "전환율은 12.5%입니다." }
          ]
        }) }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  const result = await service.translate({
    userId: "private-user",
    introduction: "제품 디자이너입니다. 화면 흐름과 사용자 경험을 담당합니다.",
    items: [
      { id: "4", text: "DB에 저장해 주세요." },
      { id: "5", text: "전환율은 12.5%입니다." }
    ]
  });

  assert.equal(result.source, "openai");
  assert.equal(result.translations[0].personalizedText, "데이터를 정리해 보관하는 공간에 저장해 주세요.");
  assert.equal(result.translations[0].changed, true);
  assert.equal(result.translations[1].personalizedText.includes("12.5%"), true);
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, "json_schema");
  assert.deepEqual(Object.keys(JSON.parse(request.input)), ["speeches"]);
  assert.equal(JSON.parse(request.input).introduction, undefined);
  assert.equal(request.instructions.includes("제품 디자이너입니다."), true);
  assert.notEqual(request.safety_identifier, "private-user");
});

test("falls back to the original when a model drops an explicit number", async () => {
  const service = new PersonalizedTranscriptService({
    apiKey: "test-key",
    fetch: async () => new Response(JSON.stringify({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({
        translations: [{ id: "7", text: "전환율이 높아졌습니다." }]
      }) }] }]
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });
  const [translation] = (await service.translate({
    userId: "u",
    items: [{ id: "7", text: "전환율이 18%로 높아졌습니다." }]
  })).translations;
  assert.equal(translation.personalizedText, "전환율이 18%로 높아졌습니다.");
  assert.equal(translation.changed, false);
});
