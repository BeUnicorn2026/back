import assert from "node:assert/strict";
import test from "node:test";
import { GoLiveMapClient, LiveMapError, isLiveMapEnabled } from "../lib/go-livemap-client.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("isLiveMapEnabled requires the explicit flag plus origin and token", () => {
  assert.equal(isLiveMapEnabled({}), false);
  assert.equal(isLiveMapEnabled({ LIVEMAP_ENABLED: "true" }), false);
  assert.equal(isLiveMapEnabled({ LIVEMAP_ENABLED: "true", GO_AI_ORIGIN: "http://x", AI_API_TOKEN: "" }), false);
  assert.equal(isLiveMapEnabled({ LIVEMAP_ENABLED: "1", GO_AI_ORIGIN: "http://x", AI_API_TOKEN: "t" }), false);
  assert.equal(isLiveMapEnabled({ LIVEMAP_ENABLED: "true", GO_AI_ORIGIN: "http://x", AI_API_TOKEN: "t" }), true);
});

test("forwards authenticated tenant-scoped livemap calls to Go", async () => {
  const requests = [];
  const client = new GoLiveMapClient({
    origin: "http://127.0.0.1:7071/",
    token: "internal-token",
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (options.method === "POST" && url.endsWith("/sessions")) return jsonResponse({ session: { id: "lm_1", status: "active", seq: 0 } }, 201);
      if (options.method === "POST" && url.endsWith("/turns")) return jsonResponse({ accepted: true, queued: 1 }, 202);
      if (options.method === "GET") return jsonResponse({ session: { id: "lm_1", status: "active", seq: 3, deltas: [] } }, 200);
      if (options.method === "POST" && url.endsWith("/finalize")) return jsonResponse({ session: { id: "lm_1", status: "finalized" }, result: { topics: [] }, metrics: {} }, 200);
      return new Response(null, { status: 204 });
    }
  });

  const created = await client.createSession({ meetingId: "meeting-1", agenda: ["안건"], tenantKey: "org-1:user-1" });
  assert.equal(created.session.id, "lm_1");
  assert.equal(requests[0].url, "http://127.0.0.1:7071/api/ai/livemap/sessions");
  assert.equal(requests[0].options.headers.Authorization, "Bearer internal-token");
  assert.equal(requests[0].options.headers["X-Voice-Partition-Tenant"], "org-1:user-1");
  assert.deepEqual(JSON.parse(requests[0].options.body), { meetingId: "meeting-1", agenda: ["안건"] });

  await client.postTurn("lm_1", { turnId: "turn-1", speaker: "민수", text: "안녕", start: 0, end: 1 }, "org-1:user-1");
  assert.equal(requests[1].url, "http://127.0.0.1:7071/api/ai/livemap/sessions/lm_1/turns");
  assert.deepEqual(JSON.parse(requests[1].options.body), { turnId: "turn-1", speaker: "민수", text: "안녕", start: 0, end: 1 });

  await client.getSession("lm_1", 3, "org-1:user-1");
  assert.equal(requests[2].url, "http://127.0.0.1:7071/api/ai/livemap/sessions/lm_1?sinceSeq=3");
  assert.equal(requests[2].options.method, "GET");

  const finalized = await client.finalizeSession("lm_1", "org-1:user-1");
  assert.equal(finalized.result.topics.length, 0);

  const deleted = await client.deleteSession("lm_1", "org-1:user-1");
  assert.equal(deleted.status, 204);
});

test("duplicate turn returns the 200 duplicate payload without throwing", async () => {
  const client = new GoLiveMapClient({
    origin: "http://x", token: "t",
    fetch: async () => jsonResponse({ accepted: false, duplicate: true }, 200)
  });
  const result = await client.postTurn("lm_1", { turnId: "turn-1" }, "org-1:user-1");
  assert.equal(result.duplicate, true);
  assert.equal(result.accepted, false);
});

test("backpressure and finalized statuses surface as typed errors", async () => {
  const backpressure = new GoLiveMapClient({ origin: "http://x", token: "t", fetch: async () => jsonResponse({ error: "busy" }, 429) });
  await assert.rejects(backpressure.postTurn("lm_1", {}, "org-1:user-1"), (error) => error instanceof LiveMapError && error.status === 429);

  const finalized = new GoLiveMapClient({ origin: "http://x", token: "t", fetch: async () => jsonResponse({ error: "finalized" }, 409) });
  await assert.rejects(finalized.postTurn("lm_1", {}, "org-1:user-1"), (error) => error.status === 409);
});

test("delete treats 404 as success", async () => {
  const client = new GoLiveMapClient({ origin: "http://x", token: "t", fetch: async () => new Response(null, { status: 404 }) });
  const result = await client.deleteSession("lm_missing", "org-1:user-1");
  assert.equal(result.status, 404);
});

test("fails closed when the internal Go service is not configured", async () => {
  const client = new GoLiveMapClient();
  assert.equal(client.enabled, false);
  await assert.rejects(client.createSession({ tenantKey: "t" }), (error) => error.status === 503);
});
