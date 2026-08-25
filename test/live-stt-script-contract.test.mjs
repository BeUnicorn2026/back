import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("live STT smoke test targets the backend development server by default", async () => {
  const source = await readFile(new URL("../scripts/test-live-stt.mjs", import.meta.url), "utf8");
  assert.match(source, /process\.env\.STT_TEST_URL \|\| "http:\/\/localhost:3001"/);
  assert.match(source, /Backend URL \(default: http:\/\/localhost:3001\)/);
});
