import assert from "node:assert/strict";
import test from "node:test";
import { TermExtractionService } from "../lib/term-extraction.mjs";

function openaiResponse(terms) {
  return new Response(JSON.stringify({
    output: [{ content: [{ type: "output_text", text: JSON.stringify({ terms }) }] }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("local mode returns no terms and never calls the network", async () => {
  let called = false;
  const service = new TermExtractionService({ fetch: async () => { called = true; } });
  assert.equal(service.mode, "local");
  const result = await service.extract({ chunk: "기존 파이프라인을 파인튜닝으로 바꾸려고 합니다." });
  assert.deepEqual(result.terms, []);
  assert.equal(called, false);
});

test("empty chunks are a normal empty result even with a key", async () => {
  let called = false;
  const service = new TermExtractionService({ apiKey: "test-key", fetch: async () => { called = true; } });
  const result = await service.extract({ chunk: "   " });
  assert.deepEqual(result.terms, []);
  assert.equal(called, false);
});

test("sends topic, defined terms, and the chunk with a strict schema", async () => {
  let request;
  const service = new TermExtractionService({
    apiKey: "test-key",
    model: "test-model",
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return openaiResponse([{
        term: "파인튜닝", surface: "파인튜닝으로", aliases: ["fine-tuning", "FT"],
        definition: "이미 학습된 모델에 데이터를 추가로 학습시키는 작업입니다."
      }]);
    }
  });
  const result = await service.extract({
    meetingTopic: "AI 프로덕트 기획 회의",
    definedTerms: ["임베딩"],
    chunk: "기존 파이프라인을 파인튜닝으로 바꾸려고 합니다."
  });
  const input = JSON.parse(request.input);
  assert.deepEqual(Object.keys(input), ["meeting_topic", "defined_terms", "transcript_chunk"]);
  assert.deepEqual(input.defined_terms, ["임베딩"]);
  assert.equal(request.store, false);
  assert.equal(request.text.format.strict, true);
  assert.equal(result.terms.length, 1);
  assert.equal(result.terms[0].surface, "파인튜닝으로");
  assert.deepEqual(result.terms[0].aliases, ["fine-tuning", "FT"]);
});

test("repairs a surface that is not actually in the chunk", async () => {
  const service = new TermExtractionService({
    apiKey: "test-key",
    fetch: async () => openaiResponse([{
      term: "임베딩", surface: "엠베딩을", aliases: [],
      definition: "의미를 숫자 벡터로 표현한 값입니다."
    }])
  });
  const result = await service.extract({ chunk: "이번에 임베딩을 도입합니다." });
  assert.equal(result.terms[0].surface, "임베딩");
});

test("drops entries missing a term or definition", async () => {
  const service = new TermExtractionService({
    apiKey: "test-key",
    fetch: async () => openaiResponse([
      { term: "", surface: "", aliases: [], definition: "정의" },
      { term: "VAD", surface: "VAD", aliases: [], definition: "" },
      { term: "임베딩", surface: "임베딩", aliases: [], definition: "의미 벡터입니다." }
    ])
  });
  const result = await service.extract({ chunk: "임베딩 VAD 이야기" });
  assert.equal(result.terms.length, 1);
  assert.equal(result.terms[0].term, "임베딩");
});

test("throws on provider errors so the caller can discard the chunk", async () => {
  const service = new TermExtractionService({
    apiKey: "test-key",
    fetch: async () => new Response("{}", { status: 500 })
  });
  await assert.rejects(service.extract({ chunk: "임베딩을 도입합니다." }), /HTTP 500/);
});
