import assert from "node:assert/strict";
import test from "node:test";
import { MeetingIntelligenceService, transcriptHash } from "../lib/meeting-intelligence.mjs";

const meeting = {
  id: "meeting-1",
  segments: [
    { speaker: "민수", start: 1, end: 3, text: "VAD와 임베딩 기준을 정하겠습니다." },
    { speaker: "지수", start: 4, end: 7, text: "민수가 내일까지 검증 결과를 확인해 주세요." }
  ]
};

test("local intelligence uses only transcript evidence and does not invent term definitions", async () => {
  const service = new MeetingIntelligenceService();
  const result = await service.analyze(meeting, { roles: ["기획"], knownTerms: [] });
  assert.equal(result.source, "local");
  assert.equal(result.terms.length, 0);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].owner, "민수");
  assert.equal(result.actions[0].due, "내일까지");
  assert.equal(result.actions[0].firstSeenAt, 4);
  assert.equal(result.topics[0].start, 1);
  assert.equal(result.topics[0].end, 7);
});

test("local action extraction leaves unsupported ownership and due dates unassigned", async () => {
  const result = await new MeetingIntelligenceService().analyze({
    segments: [{ speaker: "지수", start: 0, end: 2, text: "결과를 확인해 주세요." }]
  });
  assert.equal(result.actions[0].owner, "담당 미정");
  assert.equal(result.actions[0].due, "일정 미정");
});

test("OpenAI structured analysis is grounded and remains shared across user profiles", async () => {
  let requestBody;
  const service = new MeetingIntelligenceService({
    apiKey: "test-key",
    model: "gpt-5.4-mini",
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      const output = {
        title: "음성 인식 기준 회의",
        summary: "화자 인식 검증 기준을 논의했습니다.",
        topics: [{ label: "검증 기준", summary: "기준과 담당을 정했습니다.", segmentIndexes: [0, 1, 999], subtopics: ["VAD"] }],
        terms: [
          { term: "VAD", definition: "음성 구간 감지", explanation: "발화 구간을 찾는 기술", evidenceSegmentIndex: 0 },
          { term: "임베딩", definition: "특징 벡터", explanation: "목소리를 비교하는 숫자 표현", evidenceSegmentIndex: 0 },
          { term: "없는 말", definition: "없음", explanation: "없음", evidenceSegmentIndex: 999 }
        ],
        actions: [{ text: "검증 결과 확인", owner: "민수", due: "내일", evidenceSegmentIndex: 1 }]
      };
      return new Response(JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(output) }] }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  const result = await service.analyze(meeting, { roles: ["기획"], knownTerms: ["VAD"] });
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.text.format.type, "json_schema");
  assert.equal(requestBody.text.format.strict, true);
  assert.deepEqual(Object.keys(JSON.parse(requestBody.input)), ["transcript"]);
  assert.deepEqual(result.topics[0].segmentIndexes, [0, 1]);
  assert.deepEqual(result.topics[0].speakers, ["민수", "지수"]);
  assert.deepEqual(result.terms.map(({ term }) => term), ["VAD", "임베딩"]);
  assert.equal(result.terms[0].firstSeenAt, 1);
  assert.equal(result.actions[0].firstSeenAt, 4);
  assert.equal(result.source, "openai");
});

test("transcript hash changes when the persisted transcript changes", () => {
  const first = transcriptHash(meeting.segments);
  const second = transcriptHash(meeting.segments.map((segment, index) =>
    index ? { ...segment, text: `${segment.text} 변경` } : segment));
  assert.notEqual(first, second);
  assert.equal(first.length, 64);
});
