import { randomUUID } from "node:crypto";
import { billingPlan } from "./billing-plans.mjs";
import { openSqliteDatabase, runTransaction } from "./sqlite-database.mjs";

export class BillingError extends Error {
  constructor(message, status = 400, code = "BILLING_ERROR") {
    super(message);
    this.name = "BillingError";
    this.status = status;
    this.code = code;
  }
}

function orderFromRow(row) {
  if (!row) return null;
  return {
    orderId: row.order_id,
    userId: row.user_id,
    organizationId: row.organization_id,
    planId: row.plan_id,
    amount: row.amount,
    status: row.status,
    paymentKey: row.payment_key,
    method: row.method,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function subscriptionFromRow(row, now = new Date()) {
  if (!row || row.status !== "ACTIVE" || !row.current_period_end || new Date(row.current_period_end) <= now) {
    return { planId: "FREE", status: "ACTIVE", currentPeriodStart: null, currentPeriodEnd: null, orderId: null };
  }
  return {
    planId: row.plan_id,
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    orderId: row.order_id
  };
}

export class BillingStore {
  constructor(databasePath) {
    this.databasePath = databasePath;
    this.database = null;
    this.initializing = null;
  }

  async initialize() {
    if (!this.initializing) this.initializing = this.#initialize();
    return this.initializing;
  }

  async #initialize() {
    this.database = await openSqliteDatabase(this.databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS billing_orders (
        order_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL,
        payment_key TEXT UNIQUE,
        method TEXT,
        expires_at TEXT NOT NULL,
        approved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organization_subscriptions (
        organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL,
        current_period_start TEXT,
        current_period_end TEXT,
        order_id TEXT REFERENCES billing_orders(order_id),
        activated_by TEXT NOT NULL REFERENCES users(id),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS billing_meeting_usage (
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        period_start TEXT NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, period_start)
      );
      CREATE TABLE IF NOT EXISTS billing_meeting_events (
        organization_id TEXT NOT NULL,
        period_start TEXT NOT NULL,
        usage_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (organization_id, period_start, usage_key),
        FOREIGN KEY (organization_id, period_start)
          REFERENCES billing_meeting_usage(organization_id, period_start) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS billing_orders_user_created_idx ON billing_orders(user_id, created_at DESC);
    `);
  }

  async createOrder({ userId, organizationId, planId, now = new Date() }) {
    await this.initialize();
    const plan = billingPlan(planId);
    if (!plan || plan.amount <= 0) throw new BillingError("결제할 수 있는 유료 플랜을 선택해 주세요.", 400, "PLAN_NOT_PURCHASABLE");
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
    const orderId = `ssuon_${randomUUID().replaceAll("-", "")}`;
    this.database.prepare(`INSERT INTO billing_orders
      (order_id, user_id, organization_id, plan_id, amount, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`)
      .run(orderId, userId, organizationId, plan.id, plan.amount, expiresAt, createdAt, createdAt);
    return orderFromRow(this.database.prepare("SELECT * FROM billing_orders WHERE order_id = ?").get(orderId));
  }

  async getOrderForUser(orderId, userId) {
    await this.initialize();
    return orderFromRow(this.database.prepare("SELECT * FROM billing_orders WHERE order_id = ? AND user_id = ?").get(orderId, userId));
  }

  async beginConfirmation({ orderId, userId, amount, now = new Date() }) {
    await this.initialize();
    return runTransaction(this.database, () => {
      const order = orderFromRow(this.database.prepare("SELECT * FROM billing_orders WHERE order_id = ? AND user_id = ?").get(orderId, userId));
      if (!order) throw new BillingError("결제 주문을 찾을 수 없습니다.", 404, "PAYMENT_ORDER_NOT_FOUND");
      if (order.status === "DONE") return { order, alreadyConfirmed: true };
      if (order.status === "CONFIRMING") throw new BillingError("결제 승인을 처리하고 있습니다.", 409, "PAYMENT_CONFIRMING");
      if (order.status !== "PENDING") throw new BillingError("승인할 수 없는 결제 주문입니다.", 409, "PAYMENT_ORDER_INVALID");
      if (new Date(order.expiresAt) <= now) throw new BillingError("결제 승인 시간이 만료됐습니다.", 410, "PAYMENT_ORDER_EXPIRED");
      if (Number(amount) !== order.amount) throw new BillingError("결제 금액이 주문 금액과 일치하지 않습니다.", 400, "PAYMENT_AMOUNT_MISMATCH");
      this.database.prepare("UPDATE billing_orders SET status = 'CONFIRMING', updated_at = ? WHERE order_id = ?")
        .run(now.toISOString(), orderId);
      return { order: { ...order, status: "CONFIRMING" }, alreadyConfirmed: false };
    });
  }

  async releaseConfirmation(orderId, now = new Date()) {
    await this.initialize();
    this.database.prepare("UPDATE billing_orders SET status = 'PENDING', updated_at = ? WHERE order_id = ? AND status = 'CONFIRMING'")
      .run(now.toISOString(), orderId);
  }

  async completeConfirmation({ orderId, userId, payment, now = new Date() }) {
    await this.initialize();
    return runTransaction(this.database, () => {
      const order = orderFromRow(this.database.prepare("SELECT * FROM billing_orders WHERE order_id = ? AND user_id = ?").get(orderId, userId));
      if (!order) throw new BillingError("결제 주문을 찾을 수 없습니다.", 404, "PAYMENT_ORDER_NOT_FOUND");
      if (order.status === "DONE") return { order, subscription: subscriptionFromRow(this.database.prepare("SELECT * FROM organization_subscriptions WHERE organization_id = ?").get(order.organizationId), now) };
      if (order.status !== "CONFIRMING") throw new BillingError("결제 승인 순서가 올바르지 않습니다.", 409, "PAYMENT_ORDER_INVALID");
      if (payment.orderId !== order.orderId || Number(payment.totalAmount) !== order.amount || payment.status !== "DONE") {
        throw new BillingError("승인 결과가 저장된 주문과 일치하지 않습니다.", 502, "PAYMENT_RESULT_MISMATCH");
      }
      const plan = billingPlan(order.planId);
      const approvedAt = now.toISOString();
      const periodEnd = new Date(now.getTime() + plan.durationDays * 86_400_000).toISOString();
      this.database.prepare(`UPDATE billing_orders SET status = 'DONE', payment_key = ?, method = ?, approved_at = ?, updated_at = ?
        WHERE order_id = ?`).run(payment.paymentKey, payment.method || null, approvedAt, approvedAt, orderId);
      this.database.prepare(`INSERT INTO organization_subscriptions
        (organization_id, plan_id, status, current_period_start, current_period_end, order_id, activated_by, updated_at)
        VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
        ON CONFLICT(organization_id) DO UPDATE SET plan_id = excluded.plan_id, status = 'ACTIVE',
          current_period_start = excluded.current_period_start, current_period_end = excluded.current_period_end,
          order_id = excluded.order_id, activated_by = excluded.activated_by, updated_at = excluded.updated_at`)
        .run(order.organizationId, plan.id, approvedAt, periodEnd, orderId, userId, approvedAt);
      const completed = orderFromRow(this.database.prepare("SELECT * FROM billing_orders WHERE order_id = ?").get(orderId));
      return { completed, subscription: subscriptionFromRow(this.database.prepare("SELECT * FROM organization_subscriptions WHERE organization_id = ?").get(order.organizationId), now) };
    });
  }

  async subscriptionForOrganization(organizationId, now = new Date()) {
    await this.initialize();
    const row = this.database.prepare("SELECT * FROM organization_subscriptions WHERE organization_id = ?").get(organizationId);
    return subscriptionFromRow(row, now);
  }

  async meetingUsageForPeriod({ organizationId, periodStart, baselineUsed = 0, now = new Date() }) {
    await this.initialize();
    const used = Math.max(0, Math.floor(Number(baselineUsed) || 0));
    this.database.prepare(`INSERT OR IGNORE INTO billing_meeting_usage
      (organization_id, period_start, used_count, updated_at) VALUES (?, ?, ?, ?)`)
      .run(organizationId, periodStart, used, now.toISOString());
    return Number(this.database.prepare(`SELECT used_count FROM billing_meeting_usage
      WHERE organization_id = ? AND period_start = ?`).get(organizationId, periodStart)?.used_count || 0);
  }

  async consumeMeeting({ organizationId, periodStart, limit, usageKey, baselineUsed = 0, now = new Date() }) {
    await this.initialize();
    if (!usageKey) throw new BillingError("회의 사용량 식별자가 필요합니다.", 400, "MEETING_USAGE_KEY_REQUIRED");
    return runTransaction(this.database, () => {
      const timestamp = now.toISOString();
      const initialUsed = Math.max(0, Math.floor(Number(baselineUsed) || 0));
      this.database.prepare(`INSERT OR IGNORE INTO billing_meeting_usage
        (organization_id, period_start, used_count, updated_at) VALUES (?, ?, ?, ?)`)
        .run(organizationId, periodStart, initialUsed, timestamp);
      const duplicate = this.database.prepare(`SELECT 1 FROM billing_meeting_events
        WHERE organization_id = ? AND period_start = ? AND usage_key = ?`)
        .get(organizationId, periodStart, usageKey);
      if (duplicate) {
        const used = Number(this.database.prepare(`SELECT used_count FROM billing_meeting_usage
          WHERE organization_id = ? AND period_start = ?`).get(organizationId, periodStart).used_count);
        return { used, duplicate: true };
      }
      const maximum = limit == null ? null : Math.max(0, Math.floor(Number(limit) || 0));
      const result = maximum == null
        ? this.database.prepare(`UPDATE billing_meeting_usage SET used_count = used_count + 1, updated_at = ?
          WHERE organization_id = ? AND period_start = ?`).run(timestamp, organizationId, periodStart)
        : this.database.prepare(`UPDATE billing_meeting_usage SET used_count = used_count + 1, updated_at = ?
          WHERE organization_id = ? AND period_start = ? AND used_count < ?`).run(timestamp, organizationId, periodStart, maximum);
      if (result.changes !== 1) throw new BillingError("현재 플랜의 회의 횟수를 모두 사용했습니다.", 402, "PLAN_MEETING_LIMIT");
      this.database.prepare(`INSERT INTO billing_meeting_events
        (organization_id, period_start, usage_key, created_at) VALUES (?, ?, ?, ?)`)
        .run(organizationId, periodStart, usageKey, timestamp);
      const used = Number(this.database.prepare(`SELECT used_count FROM billing_meeting_usage
        WHERE organization_id = ? AND period_start = ?`).get(organizationId, periodStart).used_count);
      return { used, duplicate: false };
    });
  }

  async releaseMeeting({ organizationId, periodStart, usageKey, now = new Date() }) {
    await this.initialize();
    return runTransaction(this.database, () => {
      const removed = this.database.prepare(`DELETE FROM billing_meeting_events
        WHERE organization_id = ? AND period_start = ? AND usage_key = ?`)
        .run(organizationId, periodStart, usageKey);
      if (removed.changes !== 1) return false;
      this.database.prepare(`UPDATE billing_meeting_usage SET used_count = MAX(0, used_count - 1), updated_at = ?
        WHERE organization_id = ? AND period_start = ?`)
        .run(now.toISOString(), organizationId, periodStart);
      return true;
    });
  }
}
