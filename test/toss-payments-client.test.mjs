import assert from "node:assert/strict";
import test from "node:test";
import { TossPaymentsClient, TossPaymentsError } from "../lib/toss-payments-client.mjs";

test("keeps the secret server-side and sends an idempotent confirmation", async () => {
  let captured;
  const client = new TossPaymentsClient({
    clientKey: "test_ck_public",
    secretKey: "test_sk_private",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return new Response(JSON.stringify({
        orderId: "ssuon_order123", paymentKey: "payment-key", totalAmount: 39_000, status: "DONE", method: "카드"
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  assert.deepEqual(client.publicConfiguration(), { enabled: true, mode: "test", clientKey: "test_ck_public" });
  const payment = await client.confirm({ paymentKey: "payment-key", orderId: "ssuon_order123", amount: 39_000 });
  assert.equal(payment.status, "DONE");
  assert.equal(captured.url, "https://api.tosspayments.com/v1/payments/confirm");
  assert.equal(captured.options.headers["Idempotency-Key"], "ssuon_order123");
  assert.equal(captured.options.headers.Authorization, `Basic ${Buffer.from("test_sk_private:").toString("base64")}`);
  assert.doesNotMatch(JSON.stringify(client.publicConfiguration()), /test_sk_private/);
});

test("fails closed when payment keys are missing or provider data mismatches", async () => {
  await assert.rejects(
    new TossPaymentsClient().confirm({ paymentKey: "p", orderId: "order-1", amount: 1 }),
    (error) => error instanceof TossPaymentsError && error.code === "PAYMENT_NOT_CONFIGURED"
  );
  const client = new TossPaymentsClient({
    clientKey: "test_ck_public",
    secretKey: "test_sk_private",
    fetchImpl: async () => new Response(JSON.stringify({
      orderId: "another-order", paymentKey: "p", totalAmount: 1, status: "DONE"
    }), { status: 200, headers: { "Content-Type": "application/json" } })
  });
  await assert.rejects(
    client.confirm({ paymentKey: "p", orderId: "order-1", amount: 1 }),
    (error) => error instanceof TossPaymentsError && error.code === "PAYMENT_RESULT_MISMATCH"
  );
});
