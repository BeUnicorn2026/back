import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

function routeSource(start, next) {
  const startIndex = serverSource.indexOf(start);
  const endIndex = serverSource.indexOf(next, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing route: ${start}`);
  assert.notEqual(endIndex, -1, `missing next route: ${next}`);
  return serverSource.slice(startIndex, endIndex);
}

test("room meeting PATCH blocks transcript and lifecycle mutation before store update", () => {
  const patch = routeSource('app.patch("/api/meetings/:id"', 'app.delete("/api/meetings/:id"');
  assert.match(patch, /ROOM_TRANSCRIPT_MUTATION_FORBIDDEN/);
  assert.match(patch, /ROOM_MEETING_LIFECYCLE_FORBIDDEN/);
  assert.ok(patch.indexOf("ROOM_MEETING_LIFECYCLE_FORBIDDEN") < patch.indexOf("meetingStore.update"));
});

test("room meeting delete requires the room creator", () => {
  const remove = routeSource('app.delete("/api/meetings/:id"', 'app.get("/api/meetings/:id/intelligence"');
  assert.match(remove, /ROOM_MEETING_CREATOR_REQUIRED/);
  assert.ok(remove.indexOf("ROOM_MEETING_CREATOR_REQUIRED") < remove.indexOf("meetingStore.remove"));
});

test("speaker profile mutations require explicit ownership and owned store APIs", () => {
  const samples = routeSource('app.post("/api/speakers/:id/samples"', 'app.delete("/api/speakers/:id"');
  const remove = routeSource('app.delete("/api/speakers/:id"', 'app.post("/api/transcribe"');
  assert.match(samples, /!existing\.createdBy/);
  assert.match(samples, /speakerStore\.replaceOwned/);
  assert.match(remove, /!existing\.createdBy/);
  assert.match(remove, /speakerStore\.removeOwned/);
});

test("room REST routes expose access codes only from create responses", () => {
  const create = routeSource('app.post("/api/rooms"', 'app.post("/api/rooms/join"');
  const join = routeSource('app.post("/api/rooms/join"', 'app.get("/api/rooms"');
  const list = routeSource('app.get("/api/rooms"', 'app.get("/api/rooms/:id"');
  const get = routeSource('app.get("/api/rooms/:id"', 'app.post("/api/rooms/:id/close"');
  const close = routeSource('app.post("/api/rooms/:id/close"', 'app.post("/api/rooms/:id/meetings"');

  assert.match(create, /publicRoom\(room, \{ includeAccessCode: true \}\)/);
  for (const source of [join, list, get, close]) {
    assert.doesNotMatch(source, /includeAccessCode/);
    assert.match(source, /publicRoom\(room\)/);
  }
});
