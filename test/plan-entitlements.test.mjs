import assert from "node:assert/strict";
import test from "node:test";
import { entitlementPeriodStart, meetingAllowance, planEntitlements } from "../lib/plan-entitlements.mjs";

test("maps every paid state to concrete server-enforced limits", () => {
  assert.deepEqual(planEntitlements({ planId: "FREE" }), {
    planId: "FREE", meetingsPerPeriod: 3, meetingDurationSeconds: 1200, meetingParticipants: 5, speakerProfiles: 5
  });
  assert.deepEqual(planEntitlements({ planId: "PRO" }), {
    planId: "PRO", meetingsPerPeriod: null, meetingDurationSeconds: 7200, meetingParticipants: 10, speakerProfiles: 10
  });
  assert.deepEqual(planEntitlements({ planId: "MAX" }), {
    planId: "MAX", meetingsPerPeriod: null, meetingDurationSeconds: null, meetingParticipants: 20, speakerProfiles: 20
  });
});

test("uses the paid period start and a UTC calendar month for Free", () => {
  const now = new Date("2026-08-24T23:30:00-07:00");
  assert.equal(entitlementPeriodStart({ planId: "FREE" }, now), "2026-08-01T00:00:00.000Z");
  assert.equal(entitlementPeriodStart({ planId: "PRO", currentPeriodStart: "2026-08-12T08:00:00.000Z" }, now), "2026-08-12T08:00:00.000Z");
});

test("blocks a finite meeting quota but keeps Max unlimited", () => {
  assert.deepEqual(meetingAllowance(planEntitlements({ planId: "FREE" }), 2), {
    allowed: true, used: 2, limit: 3, remaining: 1
  });
  assert.equal(meetingAllowance(planEntitlements({ planId: "FREE" }), 3).allowed, false);
  assert.deepEqual(meetingAllowance(planEntitlements({ planId: "MAX" }), 10_000), {
    allowed: true, used: 10_000, limit: null, remaining: null
  });
});
