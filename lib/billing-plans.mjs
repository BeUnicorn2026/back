export const BILLING_PLANS = Object.freeze([
  Object.freeze({
    id: "FREE",
    name: "Free",
    amount: 0,
    durationDays: null,
    description: "개인과 소규모 팀이 회의 기록을 시작하는 플랜",
    features: Object.freeze(["월 5회 회의", "회의당 30분", "기본 STT 및 문서 구조화"])
  }),
  Object.freeze({
    id: "PRO",
    name: "Pro",
    amount: 39_000,
    durationDays: 30,
    description: "정기적으로 회의를 기록하고 개인화하는 팀용 플랜",
    features: Object.freeze(["월 100회 회의", "회의당 3시간", "화자 등록 및 Knowledge Twin", "구조도·트리·마인드맵"])
  }),
  Object.freeze({
    id: "MAX",
    name: "Max",
    amount: 119_000,
    durationDays: 30,
    description: "사용량이 많은 조직을 위한 최대 용량 플랜",
    features: Object.freeze(["회의 횟수 무제한", "회의당 8시간", "우선 처리 및 전체 AI 기능", "조직 멤버 관리"])
  })
]);

const planById = new Map(BILLING_PLANS.map((plan) => [plan.id, plan]));

export function billingPlan(planId) {
  return planById.get(String(planId || "").toUpperCase()) || null;
}

export function publicBillingPlans() {
  return BILLING_PLANS.map((plan) => ({ ...plan, features: [...plan.features] }));
}
