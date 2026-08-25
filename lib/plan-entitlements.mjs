import { billingPlan } from "./billing-plans.mjs";

export function entitlementPeriodStart(subscription, now = new Date()) {
  if (subscription?.planId !== "FREE" && subscription?.currentPeriodStart) {
    const paidStart = new Date(subscription.currentPeriodStart);
    if (Number.isFinite(paidStart.getTime()) && paidStart <= now) return paidStart.toISOString();
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function planEntitlements(subscription) {
  const plan = billingPlan(subscription?.planId) || billingPlan("FREE");
  return {
    planId: plan.id,
    meetingsPerPeriod: plan.limits.meetingsPerPeriod,
    meetingDurationSeconds: plan.limits.meetingDurationSeconds,
    speakerProfiles: plan.limits.speakerProfiles
  };
}

export function meetingAllowance(entitlements, usedMeetings) {
  const used = Math.max(0, Number(usedMeetings) || 0);
  const limit = entitlements.meetingsPerPeriod;
  return {
    allowed: limit == null || used < limit,
    used,
    limit,
    remaining: limit == null ? null : Math.max(0, limit - used)
  };
}
