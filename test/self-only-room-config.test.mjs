import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("self-only room transcription is explicitly enabled and requires an owned voice", async () => {
  const source = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(source, /process\.env\.SPEAKER_RECOGNITION_ENABLED === "true"/);
  assert.match(source, /speakerRecognitionEnabled && \(/);
  assert.doesNotMatch(source, /const speakerRecognitionEnabled = false/);
  assert.match(source, /legacyOwnedProfile[\s\S]*profile\.createdBy === auth\.user\.id/);
  assert.match(source, /"VOICE_PROFILE_INVALID" : "VOICE_PROFILE_MISSING"/);
  assert.match(source, /app\.post\("\/api\/rooms"[\s\S]*await roomTranscriptProfile\(request\.auth\)/);
  assert.match(source, /app\.post\("\/api\/rooms\/join"[\s\S]*await roomTranscriptProfile\(request\.auth\)/);
  assert.match(source, /if \(shouldPreloadSpeakerModel\)[\s\S]*prepareSpeakerModel\(\)/);
});
