import assert from "node:assert/strict";
import test from "node:test";
import { entitlementPeriodStart, meetingAllowance, planEntitlements } from "../lib/plan-entitlements.mjs";

test("maps every paid state to concrete server-enforced limits", () => {
  assert.deepEqual(planEntitlements({ planId: "FREE" }), {
    planId: "FREE", meetingsPerPeriod: 5, meetingDurationSeconds: 1800, speakerProfiles: 2
  });
  assert.deepEqual(planEntitlements({ planId: "PRO" }), {
    planId: "PRO", meetingsPerPeriod: 100, meetingDurationSeconds: 10800, speakerProfiles: 20
  });
  assert.deepEqual(planEntitlements({ planId: "MAX" }), {
    planId: "MAX", meetingsPerPeriod: null, meetingDurationSeconds: 28800, speakerProfiles: 100
  });
});

test("uses the paid period start and a UTC calendar month for Free", () => {
  const now = new Date("2026-08-24T23:30:00-07:00");
  assert.equal(entitlementPeriodStart({ planId: "FREE" }, now), "2026-08-01T00:00:00.000Z");
  assert.equal(entitlementPeriodStart({ planId: "PRO", currentPeriodStart: "2026-08-12T08:00:00.000Z" }, now), "2026-08-12T08:00:00.000Z");
});

test("blocks a finite meeting quota but keeps Max unlimited", () => {
  assert.deepEqual(meetingAllowance(planEntitlements({ planId: "FREE" }), 4), {
    allowed: true, used: 4, limit: 5, remaining: 1
  });
  assert.equal(meetingAllowance(planEntitlements({ planId: "FREE" }), 5).allowed, false);
  assert.deepEqual(meetingAllowance(planEntitlements({ planId: "MAX" }), 10_000), {
    allowed: true, used: 10_000, limit: null, remaining: null
  });
});
