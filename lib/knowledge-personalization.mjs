import { conceptIdFor } from "./knowledge-twin.mjs";

const roleFrames = new Map([
  ["개발", "구현 관점에서 보면"],
  ["디자인", "사용 흐름 관점에서 보면"],
  ["기획", "의사결정 관점에서 보면"],
  ["마케팅", "고객과 성과 관점에서 보면"],
  ["영업", "고객 제안 관점에서 보면"],
  ["운영", "안정적인 운영 관점에서 보면"]
]);

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function personalizeKnowledgeTerms(terms, states, roles = []) {
  const byConcept = new Map((Array.isArray(states) ? states : []).map((state) => [state.conceptId, state]));
  const frame = (Array.isArray(roles) ? roles : []).map((role) => roleFrames.get(role)).find(Boolean) || "현재 회의 맥락에서 보면";
  return (Array.isArray(terms) ? terms : []).map((term) => {
    const conceptId = conceptIdFor(term.term);
    const state = byConcept.get(conceptId);
    if (!state) return { ...term, conceptId };
    const salience = clamp(0.55 + Math.log1p(Math.max(0, Number(term.occurrences) || 1)) / 4, 0, 1);
    const score = (1 - state.pKnown) * salience * state.confidence - 0.08;
    const baseExplanation = String(term.explanation || term.personalizedExplanation || term.definition || "").trim();
    const shouldExplain = state.status !== "known" && score >= 0.08;
    const depthCue = state.status === "unknown" ? "쉽게 말해" : "핵심은";
    return {
      ...term,
      conceptId,
      isKnown: state.status === "known",
      shouldExplain,
      explanationScore: score,
      personalizedExplanation: baseExplanation && shouldExplain ? `${frame}, ${depthCue} ${baseExplanation}` : baseExplanation,
      knowledge: {
        pKnown: state.pKnown,
        confidence: state.confidence,
        status: state.status,
        evidenceCount: state.evidenceCount,
        explicitEvidenceCount: state.explicitEvidenceCount,
        lastUpdatedAt: state.lastUpdatedAt,
        source: state.source
      }
    };
  }).sort((left, right) => Number(left.isKnown) - Number(right.isKnown)
    || Number(right.explanationScore || 0) - Number(left.explanationScore || 0));
}
