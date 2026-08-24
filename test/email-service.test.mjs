import assert from "node:assert/strict";
import test from "node:test";
import { EmailDeliveryError, VerificationEmailService } from "../lib/email-service.mjs";

test("development delivery exposes the code only through the console provider result", async () => {
  const service = new VerificationEmailService({ environment: "development" });
  const originalLog = console.log;
  console.log = () => undefined;
  try {
    const result = await service.sendVerification({
      email: "user@example.com", name: "사용자", code: "123456", expiresAt: new Date().toISOString()
    });
    assert.deepEqual(result, { provider: "console", developmentCode: "123456" });
  } finally {
    console.log = originalLog;
  }
});

test("Resend delivery escapes HTML and supplies an idempotency key", async () => {
  let request;
  const service = new VerificationEmailService({
    environment: "production",
    apiKey: "re_test",
    from: "Voice Partition <verify@example.com>",
    fetch: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ id: "email-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  const result = await service.sendVerification({
    email: "user@example.com", name: "<사용자>", code: "654321",
    expiresAt: new Date().toISOString(), idempotencyKey: "verification-1"
  });
  const body = JSON.parse(request.options.body);
  assert.equal(result.messageId, "email-1");
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.options.headers["Idempotency-Key"], "verification-1");
  assert.match(body.html, /&lt;사용자&gt;/);
  assert.doesNotMatch(body.html, /<사용자>/);
});

test("production email delivery fails closed when credentials are absent", () => {
  const service = new VerificationEmailService({ environment: "production" });
  assert.throws(() => service.assertConfigured(), (error) => error instanceof EmailDeliveryError);
});
