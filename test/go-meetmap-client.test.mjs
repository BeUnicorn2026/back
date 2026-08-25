import assert from "node:assert/strict";
import test from "node:test";
import { GoMeetMapClient } from "../lib/go-meetmap-client.mjs";

test("forwards authenticated tenant-scoped MeetMap jobs to Go", async () => {
  const requests = [];
  const client = new GoMeetMapClient({
    origin: "http://127.0.0.1:7071/",
    token: "internal-token",
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ job: { id: "map_1234567890abcdef1234567890abcdef", status: "queued" } }), {
        status: options.method === "POST" ? 202 : 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  await client.submit({ meetingId: "meeting-1", segments: [{ text: "안건" }], tenantKey: "org-1:user-1" });
  await client.get("map_1234567890abcdef1234567890abcdef", "org-1:user-1");
  assert.equal(requests[0].url, "http://127.0.0.1:7071/api/ai/meetmap/jobs");
  assert.equal(requests[0].options.headers.Authorization, "Bearer internal-token");
  assert.equal(requests[0].options.headers["X-Voice-Partition-Tenant"], "org-1:user-1");
  assert.deepEqual(JSON.parse(requests[0].options.body), { meetingId: "meeting-1", segments: [{ text: "안건" }] });
  assert.equal(requests[1].options.method, "GET");
});

test("fails closed when the internal Go service is not configured", async () => {
  const client = new GoMeetMapClient();
  await assert.rejects(client.submit({ segments: [] }), (error) => error.status === 503);
  await assert.rejects(client.get("not-a-job", "tenant"), /작업 ID/);
});
