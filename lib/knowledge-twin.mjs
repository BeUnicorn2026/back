import { createHash } from "node:crypto";

const MINIMUM_PROBABILITY = 0.0025;
const MAXIMUM_PROBABILITY = 1 - MINIMUM_PROBABILITY;
const DEFAULT_PRIOR = 0.35;
const DEFAULT_HALF_LIFE_MS = 180 * 24 * 60 * 60 * 1_000;

export const KNOWLEDGE_EVIDENCE_RULES = Object.freeze({
  mark_known: { targetProbability: 0.92, evidenceWeight: 2.5, explicit: true },
  mark_unknown: { targetProbability: 0.08, evidenceWeight: 2.5, explicit: true },
  request_simpler: { delta: -1.6, evidenceWeight: 1.6, explicit: true },
  correct_answer: { delta: 1.4, evidenceWeight: 1.4, explicit: true },
  incorrect_answer: { delta: -1.4, evidenceWeight: 1.4, explicit: true },
  context_use: { delta: 0.3, evidenceWeight: 0.3, explicit: false },
  card_open: { delta: -0.1, evidenceWeight: 0.1, explicit: false }
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeConceptLabel(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 80);
}

export function conceptIdFor(value) {
  const label = normalizeConceptLabel(value);
  if (!label) return "";
  const key = label.toLocaleLowerCase("ko-KR");
  return `concept_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

export function logit(probability) {
  const safe = clamp(Number(probability) || DEFAULT_PRIOR, MINIMUM_PROBABILITY, MAXIMUM_PROBABILITY);
  return Math.log(safe / (1 - safe));
}

export function probabilityFromLogOdds(logOdds) {
  return 1 / (1 + Math.exp(-clamp(Number(logOdds) || 0, -6, 6)));
}

export function initialKnowledgeState({ prior = DEFAULT_PRIOR, now = new Date().toISOString() } = {}) {
  const priorLogOdds = logit(prior);
  return {
    logOdds: priorLogOdds,
    priorLogOdds,
    evidenceCount: 0,
    evidenceWeight: 0,
    explicitEvidenceCount: 0,
    lastUpdatedAt: now
  };
}

export function decayedKnowledgeState(state, {
  now = new Date().toISOString(),
  halfLifeMs = DEFAULT_HALF_LIFE_MS
} = {}) {
  const previousTime = Date.parse(state?.lastUpdatedAt || now);
  const currentTime = Date.parse(now);
  const elapsed = Number.isFinite(previousTime) && Number.isFinite(currentTime)
    ? Math.max(0, currentTime - previousTime)
    : 0;
  if (!elapsed || !Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return { ...state, lastUpdatedAt: now };
  const retention = Math.pow(0.5, elapsed / halfLifeMs);
  return {
    ...state,
    logOdds: state.priorLogOdds + (state.logOdds - state.priorLogOdds) * retention,
    lastUpdatedAt: now
  };
}

export function applyKnowledgeEvidence(state, kind, {
  sameKindCount = 0,
  now = new Date().toISOString(),
  halfLifeMs = DEFAULT_HALF_LIFE_MS
} = {}) {
  const rule = KNOWLEDGE_EVIDENCE_RULES[kind];
  if (!rule) throw new Error("지원하지 않는 지식 증거입니다.");
  const current = decayedKnowledgeState(state, { now, halfLifeMs });
  const repetitionFactor = rule.targetProbability == null ? 1 / Math.sqrt(Math.max(1, sameKindCount + 1)) : 1;
  const delta = rule.targetProbability == null
    ? rule.delta * repetitionFactor
    : logit(rule.targetProbability) - current.logOdds;
  return {
    state: {
      ...current,
      logOdds: clamp(current.logOdds + delta, -6, 6),
      evidenceCount: current.evidenceCount + 1,
      evidenceWeight: current.evidenceWeight + rule.evidenceWeight * repetitionFactor,
      explicitEvidenceCount: current.explicitEvidenceCount + Number(rule.explicit),
      lastUpdatedAt: now
    },
    delta,
    rule
  };
}

export function knowledgeConfidence(state) {
  const evidenceWeight = Math.max(0, Number(state?.evidenceWeight) || 0);
  return 0.25 + 0.75 * (1 - Math.exp(-evidenceWeight / 3));
}

export function knowledgeView(state, options = {}) {
  const current = decayedKnowledgeState(state, options);
  const pKnown = probabilityFromLogOdds(current.logOdds);
  const confidence = knowledgeConfidence(current);
  return {
    ...current,
    pKnown,
    confidence,
    status: pKnown >= 0.75 ? "known" : pKnown <= 0.3 ? "unknown" : "learning"
  };
}

export function explanationScore(state, {
  salience = 1,
  interruptionCost = 0.08,
  now,
  halfLifeMs
} = {}) {
  const view = knowledgeView(state, { now, halfLifeMs });
  return (1 - view.pKnown) * clamp(Number(salience) || 0, 0, 1) * view.confidence
    - clamp(Number(interruptionCost) || 0, 0, 1);
}

export function shouldExplainConcept(state, metadata = {}, threshold = 0.08) {
  return explanationScore(state, metadata) >= threshold;
}

export const knowledgeTwinDefaults = Object.freeze({
  prior: DEFAULT_PRIOR,
  knownPrior: 0.9,
  halfLifeMs: DEFAULT_HALF_LIFE_MS
});
