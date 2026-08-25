export const BILLING_PLANS = Object.freeze([
  Object.freeze({
    id: "FREE",
    name: "Free(개인)",
    amount: 0,
    durationDays: null,
    limits: Object.freeze({ meetingsPerPeriod: 3, meetingDurationSeconds: 20 * 60, meetingParticipants: 5, speakerProfiles: 5 }),
    description: "개인 회의 기록을 가볍게 시작하는 플랜",
    features: Object.freeze(["회의 시간 20분", "회의 기록 3개", "회의 참가자 5명"])
  }),
  Object.freeze({
    id: "PRO",
    name: "Pro",
    amount: 39_000,
    durationDays: 30,
    limits: Object.freeze({ meetingsPerPeriod: null, meetingDurationSeconds: 2 * 60 * 60, meetingParticipants: 10, speakerProfiles: 10 }),
    description: "정기적인 팀 회의를 제한 없이 보관하는 플랜",
    features: Object.freeze(["회의 시간 2시간", "회의 기록 제한 없음", "회의 참가자 10명"])
  }),
  Object.freeze({
    id: "MAX",
    name: "Enterprise",
    amount: 119_000,
    durationDays: 30,
    limits: Object.freeze({ meetingsPerPeriod: null, meetingDurationSeconds: null, meetingParticipants: 20, speakerProfiles: 20 }),
    description: "시간 제한 없이 운영하는 조직용 플랜",
    features: Object.freeze(["회의 시간 제한 없음", "회의 기록 제한 없음", "회의 참가자 20명"])
  })
]);

const planById = new Map(BILLING_PLANS.map((plan) => [plan.id, plan]));

export function billingPlan(planId) {
  return planById.get(String(planId || "").toUpperCase()) || null;
}

export function publicBillingPlans() {
  return BILLING_PLANS.map((plan) => ({ ...plan, features: [...plan.features], limits: { ...plan.limits } }));
}
