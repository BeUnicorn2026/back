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

function requiresMeetingAccess(source) {
  assert.match(source, /requireMeetingAccess\(\{/);
  assert.match(source, /meetingStore/);
  assert.match(source, /roomStore/);
  assert.match(source, /auth: request\.auth/);
}

test("room-bound meeting and analysis routes require room membership", () => {
  const routes = [
    routeSource('app.get("/api/meetings/:id"', 'app.post("/api/meetmap/jobs"'),
    routeSource('app.post("/api/meetmap/jobs"', 'app.get("/api/meetmap/jobs/:id"'),
    routeSource('app.get("/api/meetmap/jobs/:id"', 'app.get("/api/meetings/:id/meetmap"'),
    routeSource('app.get("/api/meetings/:id/meetmap"', 'app.post("/api/meetings"'),
    routeSource('app.patch("/api/meetings/:id"', 'app.delete("/api/meetings/:id"'),
    routeSource('app.delete("/api/meetings/:id"', 'app.get("/api/meetings/:id/intelligence"'),
    routeSource('app.get("/api/meetings/:id/intelligence"', 'app.post("/api/meetings/:id/intelligence"'),
    routeSource('app.post("/api/meetings/:id/intelligence"', 'app.post("/api/speakers"')
  ];
  for (const route of routes) requiresMeetingAccess(route);
});

test("generic meeting lists filter inaccessible room meetings", () => {
  const route = routeSource('app.get("/api/meetings"', 'app.get("/api/meetings/:id"');
  assert.match(route, /filterMeetingsForAccess\(\{ meetings, roomStore, auth: request\.auth \}\)/);
});

test("personalized transcript translation uses server-authorized meeting text and the signed-in introduction", () => {
  const route = routeSource('app.post("/api/transcript/translations"', 'app.post("/api/knowledge/explanations"');
  requiresMeetingAccess(route);
  assert.match(route, /request\.auth\.user\.introduction/);
  assert.match(route, /meeting\.segments\.map/);
  assert.doesNotMatch(route, /request\.body\?\.text/);
  assert.match(route, /translateTranscriptForViewer/);
  assert.match(route, /speakerUserId: segment\.userId/);
});

test("room transcripts cannot be replaced through generic meeting autosave", () => {
  const route = routeSource('app.patch("/api/meetings/:id"', 'app.delete("/api/meetings/:id"');
  assert.match(route, /existing\.roomId && request\.body\?\.segments !== undefined/);
  assert.match(route, /ROOM_TRANSCRIPT_MUTATION_FORBIDDEN/);
  assert.ok(route.indexOf("ROOM_TRANSCRIPT_MUTATION_FORBIDDEN") < route.indexOf("meetingStore.update"));
});
