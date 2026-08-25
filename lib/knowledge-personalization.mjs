import { conceptIdFor } from "./knowledge-twin.mjs";

const frame = "현재 회의 맥락에서 보면";

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

// Shared analysis stays role-neutral. Per-learner tailoring comes from the user's
// self-introduction, which is injected into the knowledge-explanation prompt, not
// from a coarse role frame.
export function personalizeKnowledgeTerms(terms, states) {
  const byConcept = new Map((Array.isArray(states) ? states : []).map((state) => [state.conceptId, state]));
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
