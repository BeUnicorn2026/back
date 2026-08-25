import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BillingError, BillingStore } from "../lib/billing-store.mjs";
import { closeSqliteDatabases, openSqliteDatabase } from "../lib/sqlite-database.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voice-partition-billing-"));
  const databasePath = path.join(directory, "billing.sqlite");
  const database = await openSqliteDatabase(databasePath);
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    INSERT INTO users (id) VALUES ('user-1');
    INSERT INTO organizations (id) VALUES ('org-1');
  `);
  const store = new BillingStore(databasePath);
  await store.initialize();
  return store;
}

test.afterEach(() => closeSqliteDatabases());

test("creates server-priced orders and rejects a client amount change", async () => {
  const store = await fixture();
  const now = new Date("2026-08-24T12:00:00.000Z");
  const order = await store.createOrder({ userId: "user-1", organizationId: "org-1", planId: "PRO", now });
  assert.equal(order.amount, 39_000);
  assert.match(order.orderId, /^ssuon_[a-f0-9]{32}$/);
  await assert.rejects(
    store.beginConfirmation({ orderId: order.orderId, userId: "user-1", amount: 1, now }),
    (error) => error instanceof BillingError && error.code === "PAYMENT_AMOUNT_MISMATCH"
  );
});

test("activates exactly the paid plan after a matching provider result", async () => {
  const store = await fixture();
  const now = new Date("2026-08-24T12:00:00.000Z");
  const order = await store.createOrder({ userId: "user-1", organizationId: "org-1", planId: "MAX", now });
  await store.beginConfirmation({ orderId: order.orderId, userId: "user-1", amount: 119_000, now });
  const result = await store.completeConfirmation({
    orderId: order.orderId,
    userId: "user-1",
    now,
    payment: { orderId: order.orderId, paymentKey: "payment-test", totalAmount: 119_000, status: "DONE", method: "카드" }
  });
  assert.equal(result.subscription.planId, "MAX");
  assert.equal(result.subscription.currentPeriodEnd, "2026-09-23T12:00:00.000Z");
  assert.equal((await store.getOrderForUser(order.orderId, "user-1")).paymentKey, "payment-test");
});

test("expired paid subscriptions safely fall back to Free", async () => {
  const store = await fixture();
  assert.deepEqual(await store.subscriptionForOrganization("org-1"), {
    planId: "FREE", status: "ACTIVE", currentPeriodStart: null, currentPeriodEnd: null, orderId: null
  });
});
