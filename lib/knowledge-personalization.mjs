import { createHash } from "node:crypto";
import { conceptIdFor } from "./concept-label.mjs";
import { safetyIdentifierFor } from "./knowledge-explanation.mjs";

// Stage 2 개인화 필터: 회의 전체가 공유하는 용어 목록에서 "이 청자가 이미 아는
// 용어"만 골라 숨긴다. 판단 근거는 회원가입 때 입력한 자기소개(User Profile)와
// 사용자가 등록한 아는 용어 목록(User preference)이며, 원칙은 fail-open이다 —
// 판단 근거가 부족하거나 LLM 호출이 실패하면 무조건 노출한다.
//
// 프롬프트는 Song et al. (arXiv:2508.10239) A.2 "Personalization" 원문을 그대로
// 쓴다. 출력의 refined_glossary가 동적 키 형식이라 strict json_schema로 표현할
// 수 없어, 이 호출은 스키마 강제 없이 텍스트를 JSON으로 파싱한다. 서버는
// understood_terms만 신뢰하고(후보 교집합으로 환각 방어) 나머지는 무시한다.

const SYSTEM_MESSAGE = `You are given a glossary, a user profile, and a user preference list. Your job is to remove terms the user is likely to already understand based on their profile and preference list. The input glossary is provided in valid JSON format, where each item is structured as {"term": "definition"}. Examine only the terms (the keys in the JSON) and remove the terms the user is likely already familiar with from the glossary. Return only valid JSON structured exactly as: {"understood_terms": ["term1", "term2", ...], "refined_glossary": [{"term": "definition"}, ...]}. Do not include any extra commentary or text.`;

function clean(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

// 용어 대조용 정규화 키 (계약서 §5): NFKC → 소문자화 → 모든 공백 제거 →
// 하이픈/언더스코어/가운뎃점 제거. "Fine-Tuning" / "fine tuning" / "파인 튜닝"이
// 표기 차이로 갈라지지 않도록 후보·모델 응답·knownTerms를 전부 이 키로 비교한다.
export function normalizeTermKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[\s­·\-_]+/g, "")
    .slice(0, 120);
}

function responseText(payload) {
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content.text) return content.text;
    }
  }
  return "";
}

function parseFilterResult(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last <= first) throw new Error("개인화 필터 응답이 JSON 객체가 아닙니다.");
  const parsed = JSON.parse(trimmed.slice(first, last + 1));
  return Array.isArray(parsed?.understood_terms) ? parsed.understood_terms : [];
}

// 자기소개 기반 Stage 2 호출. 결과는 (모델, 글로서리, 프로필, 선호 목록) 키로
// 메모리 캐시되므로 같은 회의 화면을 다시 열어도 재호출하지 않는다.
export class KnowledgeFilterService {
  constructor(options = {}) {
    this.apiKey = options.apiKey || "";
    this.model = options.model || "gpt-5.4-mini";
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 8_000);
    this.cacheTtlMs = Math.max(0, Number(options.cacheTtlMs) || 10 * 60_000);
    this.cacheLimit = Math.max(1, Number(options.cacheLimit) || 500);
    this.cache = new Map();
  }

  get mode() {
    return this.apiKey ? "openai" : "local";
  }

  #cacheKey(introduction, glossary, preferences) {
    return createHash("sha256")
      .update(JSON.stringify({ model: this.model, introduction, glossary, preferences }))
      .digest("hex");
  }

  #readCache(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  #writeCache(key, familiarKeys) {
    this.cache.set(key, { familiarKeys: [...familiarKeys], at: Date.now() });
    while (this.cache.size > this.cacheLimit) {
      this.cache.delete(this.cache.keys().next().value);
    }
  }

  // 반환: { familiarKeys: Set<정규화 키>, source, model }. 어떤 실패 경로에서도
  // 던지지 않고 빈 집합(=전부 노출)으로 귀결된다.
  // candidateTerms 항목은 문자열 또는 {term, definition}이며, knownTerms는 논문
  // 프롬프트의 User preference 목록으로 전달된다.
  async familiarTerms({ userId, introduction = "", candidateTerms = [], knownTerms = [] } = {}) {
    const safeIntroduction = clean(introduction, 500);
    const unique = new Map();
    for (const candidate of Array.isArray(candidateTerms) ? candidateTerms : []) {
      const source = typeof candidate === "string" ? { term: candidate, definition: "" } : candidate || {};
      const term = clean(source.term, 80);
      const key = normalizeTermKey(term);
      if (term && key && !unique.has(key)) unique.set(key, { term, definition: clean(source.definition, 300) });
    }
    const candidates = [...unique.values()].sort((a, b) => a.term.localeCompare(b.term, "ko"));
    if (!candidates.length) return { familiarKeys: new Set(), source: "empty", model: null };
    // 자기소개가 없으면 판단 근거가 없다는 뜻이고, 전부 노출한다(fail-open).
    if (!safeIntroduction) return { familiarKeys: new Set(), source: "no_introduction", model: null };
    if (!this.apiKey) return { familiarKeys: new Set(), source: "local", model: null };

    // 논문 형식: 글로서리는 {"용어": "정의"} 객체의 배열이다.
    const glossary = candidates.map(({ term, definition }) => ({ [term]: definition }));
    const preferences = (Array.isArray(knownTerms) ? knownTerms : []).map((term) => clean(term, 80)).filter(Boolean);
    const cacheKey = this.#cacheKey(safeIntroduction, glossary, preferences);
    const cached = this.#readCache(cacheKey);
    if (cached) return { familiarKeys: new Set(cached.familiarKeys), source: "openai", model: this.model, cached: true };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      let response;
      try {
        response = await this.fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          signal: controller.signal,
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            store: false,
            safety_identifier: safetyIdentifierFor(userId),
            // 논문 파라미터는 temperature 0.1 / max 1000이지만, reasoning 계열
            // 모델의 Responses API는 temperature를 거부하므로 effort로 대신한다.
            reasoning: { effort: "low" },
            max_output_tokens: 1_000,
            instructions: SYSTEM_MESSAGE,
            input: `Glossary: ${JSON.stringify(glossary)}, User Profile: ${safeIntroduction}, User preference: ${JSON.stringify(preferences)}`
          })
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`개인화 필터 실패: HTTP ${response.status}`);
      const payload = await response.json();
      const text = responseText(payload);
      if (!text) throw new Error("개인화 필터가 결과를 반환하지 않았습니다.");
      // 환각 방어: 글로서리에 없는 용어는 조용히 버린다.
      const familiarKeys = new Set(
        parseFilterResult(text).map(normalizeTermKey).filter((key) => unique.has(key))
      );
      this.#writeCache(cacheKey, familiarKeys);
      return { familiarKeys, source: "openai", model: this.model };
    } catch {
      // fail-open: 타임아웃·HTTP 오류·파싱 실패 전부 "숨기지 않음"으로 귀결된다.
      return { familiarKeys: new Set(), source: "fail_open", model: this.model };
    }
  }
}

// 공유 용어 목록에 한 사용자의 필터 결과를 적용한다. 숨김 결정은 두 가지뿐이다:
// 사용자가 직접 등록한 knownTerms(명시 신호, 모델 판단보다 우선)와 자기소개 기반
// familiarKeys. 그 외에는 전부 노출(shouldExplain=true)이 기본값이다.
export function personalizeKnowledgeTerms(terms, { familiarKeys, knownTerms, source = "default" } = {}) {
  const familiar = familiarKeys instanceof Set ? familiarKeys : new Set(familiarKeys || []);
  const known = new Set((Array.isArray(knownTerms) ? knownTerms : []).map(normalizeTermKey).filter(Boolean));
  return (Array.isArray(terms) ? terms : []).map((term) => {
    const key = normalizeTermKey(term.term);
    const explicitKnown = known.has(key);
    const familiarKnown = familiar.has(key);
    const isKnown = explicitKnown || familiarKnown;
    const baseExplanation = String(term.explanation || term.personalizedExplanation || term.definition || "").trim();
    return {
      ...term,
      conceptId: conceptIdFor(term.term),
      isKnown,
      shouldExplain: !isKnown,
      explanationScore: isKnown ? 0 : 1,
      personalizedExplanation: baseExplanation,
      knowledge: {
        status: isKnown ? "known" : "unknown",
        source: explicitKnown ? "explicit" : familiarKnown ? "introduction" : source
      }
    };
  }).sort((left, right) => Number(left.isKnown) - Number(right.isKnown)
    || Number(right.occurrences || 0) - Number(left.occurrences || 0)
    || String(left.term).localeCompare(String(right.term), "ko"));
}
