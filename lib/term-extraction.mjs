// Stage 1 용어 추출: STT 청크에서 청자가 모를 법한 용어를 뽑아 짧은 정의를
// 만든다. 세션 전체가 공유하는 호출이라 참가자 수와 무관하게 청크당 1회만
// 실행되고, 이미 정의된 용어(defined_terms)는 다시 뽑지 않는다. 실패 시 해당
// 청크만 버려진다 — 호출자가 조용히 폐기한다.
//
// 프롬프트는 Song et al. (arXiv:2508.10239) A.1 "Jargon Identification &
// Explanation" 원문을 그대로 쓴다. 논문 출력 형식이 [{"용어": "정의"}, ...]처럼
// 키가 동적이라 OpenAI strict json_schema로 표현할 수 없으므로, 이 호출만은
// 스키마 강제 없이 텍스트를 JSON으로 파싱한다.

const SYSTEM_MESSAGE = `Your job is to help a listener understand speeches that might contain jargon terms they are unfamiliar with. You will be given the transcript snippet. For each snippet, the format will be "Transcript: [snippet]". Your task is to first identify any of those terms that the listener might not fully understand, then provide a definition for each term in concise plain language. Your output should be in the format of a list of term-definition pairs. Return only valid JSON in the format [{"term": "definition"}, ...]. Do not include additional commentary or text outside the JSON. Leave the list blank if you think all the terms in the input transcript are common words that don't need additional explanations. Do not include terms that are already in the previously defined term list.`;

function clean(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function responseText(payload) {
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content.text) return content.text;
    }
  }
  return "";
}

// 논문 형식([{"용어": "정의"}])과, 모델이 흔히 내는 변형
// ([{"term": "...", "definition": "..."}])을 모두 용어-정의 쌍으로 해석한다.
function parsePairs(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = trimmed.indexOf("[");
  const last = trimmed.lastIndexOf("]");
  if (first === -1 || last <= first) throw new Error("용어 추출 응답이 JSON 배열이 아닙니다.");
  const parsed = JSON.parse(trimmed.slice(first, last + 1));
  if (!Array.isArray(parsed)) throw new Error("용어 추출 응답이 JSON 배열이 아닙니다.");
  const pairs = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.term === "string" && typeof item.definition === "string") {
      pairs.push([item.term, item.definition]);
      continue;
    }
    const [entry] = Object.entries(item);
    if (entry && typeof entry[1] === "string") pairs.push([entry[0], entry[1]]);
  }
  return pairs;
}

// surface는 자막 하이라이팅에 쓰인다. 논문 프롬프트에는 surface 개념이 없으므로
// 청크에서 용어의 실제 등장 표기를 찾아 채우고, 없으면 term 그대로 둔다.
function resolveSurface(chunk, term) {
  const index = chunk.toLocaleLowerCase("ko-KR").indexOf(term.toLocaleLowerCase("ko-KR"));
  if (index === -1) return term;
  return chunk.slice(index, index + term.length);
}

export class TermExtractionService {
  constructor(options = {}) {
    this.apiKey = options.apiKey || "";
    this.model = options.model || "gpt-5.4-mini";
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Math.max(1_000, Number(options.timeoutMs) || 4_000);
  }

  get mode() {
    return this.apiKey ? "openai" : "local";
  }

  // 반환: { terms: [{term, surface, aliases, definition}], source }.
  // 빈 배열은 정상 응답이다(일상 대화 구간). 네트워크·파싱 실패는 그대로 던지고,
  // 호출자(브리지)가 청크 폐기로 처리한다.
  async extract({ definedTerms = [], chunk = "" } = {}) {
    const safeChunk = clean(chunk, 1_200);
    if (!safeChunk) return { terms: [], source: "empty" };
    if (!this.apiKey) return { terms: [], source: "local" };

    const defined = (Array.isArray(definedTerms) ? definedTerms : [])
      .map((term) => clean(term, 80)).filter(Boolean).slice(0, 120);
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
          // 논문 파라미터는 temperature 0.1 / max 1000이지만, reasoning 계열
          // 모델의 Responses API는 temperature를 거부하므로 effort로 대신한다.
          reasoning: { effort: "low" },
          max_output_tokens: 1_000,
          instructions: SYSTEM_MESSAGE,
          input: `Transcript: ${safeChunk}, Previously defined terms: ${JSON.stringify(defined)}`
        })
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`용어 추출 실패: HTTP ${response.status}`);
    const payload = await response.json();
    const text = responseText(payload);
    if (!text) throw new Error("용어 추출이 결과를 반환하지 않았습니다.");
    const terms = parsePairs(text).map(([rawTerm, rawDefinition]) => {
      const term = clean(rawTerm, 80);
      const definition = clean(rawDefinition, 300);
      if (!term || !definition) return null;
      return { term, surface: resolveSurface(safeChunk, term), aliases: [], definition };
    }).filter(Boolean).slice(0, 8);
    return { terms, source: "openai" };
  }
}
