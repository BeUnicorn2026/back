import assert from "node:assert/strict";
import test from "node:test";
import { buildDeepgramLiveQuery } from "../lib/deepgram-live-options.mjs";

test("configures Nova-3 live meeting transcription with VAD and Korean formatting", () => {
  const query = buildDeepgramLiveQuery({
    language: "ko",
    mode: "speaker",
    keyterms: ["벡터 검색", "민수"]
  });
  assert.equal(query.get("model"), "nova-3");
  assert.equal(query.get("language"), "ko-KR");
  assert.equal(query.get("diarize_model"), "latest");
  assert.equal(query.get("interim_results"), "true");
  assert.equal(query.get("vad_events"), "true");
  assert.equal(query.get("utterance_end_ms"), "1000");
  assert.equal(query.get("numerals"), "true");
  assert.deepEqual(query.getAll("keyterm"), ["벡터 검색", "민수"]);
});

test("keeps plain STT free of diarization and unsupported numeral formatting", () => {
  const query = buildDeepgramLiveQuery({ language: "ja", mode: "stt" });
  assert.equal(query.get("language"), "ja");
  assert.equal(query.has("diarize_model"), false);
  assert.equal(query.has("numerals"), false);
});
