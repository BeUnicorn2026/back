import assert from "node:assert/strict";
import test from "node:test";
import { TermExtractionService } from "../lib/term-extraction.mjs";

function openaiText(text) {
  return new Response(JSON.stringify({
    output: [{ content: [{ type: "output_text", text }] }]
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

test("uses the paper's A.1 prompt and user-message format without a schema", async () => {
  let request;
  const service = new TermExtractionService({
    apiKey: "test-key",
    model: "test-model",
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return openaiText('[{"SLA": "서비스 제공 수준을 계약으로 보장하는 약속입니다."}]');
    }
  });
  const result = await service.extract({
    definedTerms: ["임베딩"],
    chunk: "SLA 위반이 계속되면 ARR에도 영향이 갑니다."
  });
  assert.match(request.instructions, /^Your job is to help a listener understand speeches/);
  assert.match(request.instructions, /previously defined term list\.$/);
  assert.equal(request.input, 'Transcript: SLA 위반이 계속되면 ARR에도 영향이 갑니다., Previously defined terms: ["임베딩"]');
  assert.equal(request.store, false);
  assert.equal(request.max_output_tokens, 1000);
  assert.equal("text" in request, false);
  assert.equal(result.terms.length, 1);
  assert.equal(result.terms[0].term, "SLA");
  assert.equal(result.terms[0].surface, "SLA");
  assert.deepEqual(result.terms[0].aliases, []);
});

test("accepts both paper-style pairs and term/definition objects, with fences", async () => {
  const service = new TermExtractionService({
    apiKey: "test-key",
    fetch: async () => openaiText('```json\n[{"파인튜닝": "추가 학습 작업입니다."}, {"term": "임베딩", "definition": "의미 벡터입니다."}]\n```')
  });
  const result = await service.extract({ chunk: "파인튜닝으로 임베딩을 만들죠." });
  assert.deepEqual(result.terms.map(({ term }) => term), ["파인튜닝", "임베딩"]);
  assert.deepEqual(result.terms.map(({ definition }) => definition), ["추가 학습 작업입니다.", "의미 벡터입니다."]);
});

test("surface uses the chunk's actual spelling, falling back to the term", async () => {
  const service = new TermExtractionService({
    apiKey: "test-key",
    fetch: async () => openaiText('[{"sla": "서비스 수준 계약입니다."}, {"온프레미스": "자체 서버 운영 방식입니다."}]')
  });
  const result = await service.extract({ chunk: "SLA 조건을 다시 봅시다." });
  assert.equal(result.terms[0].surface, "SLA");
  assert.equal(result.terms[1].surface, "온프레미스");
});

test("drops pairs missing a term or definition", async () => {
  const service = new TermExtractionService({
    apiKey: "test-key",
    fetch: async () => openaiText('[{"": "정의"}, {"VAD": ""}, {"임베딩": "의미 벡터입니다."}]')
  });
  const result = await service.extract({ chunk: "임베딩 VAD 이야기" });
  assert.equal(result.terms.length, 1);
  assert.equal(result.terms[0].term, "임베딩");
});

test("throws on provider errors and non-JSON output so the chunk is discarded", async () => {
  const failing = new TermExtractionService({
    apiKey: "test-key",
    fetch: async () => new Response("{}", { status: 500 })
  });
  await assert.rejects(failing.extract({ chunk: "임베딩을 도입합니다." }), /HTTP 500/);
  const chatty = new TermExtractionService({
    apiKey: "test-key",
    fetch: async () => openaiText("죄송하지만 용어를 찾지 못했습니다.")
  });
  await assert.rejects(chatty.extract({ chunk: "임베딩을 도입합니다." }), /JSON/);
});
