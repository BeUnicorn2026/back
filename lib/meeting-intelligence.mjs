import { createHash } from "node:crypto";
import { actionDueFromEvidence, actionOwnerFromEvidence } from "./action-evidence.mjs";

const analysisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "topics", "terms", "actions"],
  properties: {
    title: { type: "string", maxLength: 120 },
    summary: { type: "string", maxLength: 1200 },
    topics: {
      type: "array", maxItems: 16, items: {
        type: "object", additionalProperties: false,
        required: ["label", "summary", "segmentIndexes", "subtopics"],
        properties: {
          label: { type: "string", maxLength: 80 },
          summary: { type: "string", maxLength: 500 },
          segmentIndexes: { type: "array", maxItems: 100, items: { type: "integer", minimum: 0 } },
          subtopics: { type: "array", maxItems: 8, items: { type: "string", maxLength: 80 } }
        }
      }
    },
    terms: {
      type: "array", maxItems: 30, items: {
        type: "object", additionalProperties: false,
        required: ["term", "definition", "personalizedExplanation", "evidenceSegmentIndex"],
        properties: {
          term: { type: "string", maxLength: 80 },
          definition: { type: "string", maxLength: 500 },
          personalizedExplanation: { type: "string", maxLength: 700 },
          evidenceSegmentIndex: { type: "integer", minimum: 0 }
        }
      }
    },
    actions: {
      type: "array", maxItems: 30, items: {
        type: "object", additionalProperties: false,
        required: ["text", "owner", "due", "evidenceSegmentIndex"],
        properties: {
          text: { type: "string", maxLength: 500 },
          owner: { type: "string", maxLength: 80 },
          due: { type: "string", maxLength: 80 },
          evidenceSegmentIndex: { type: "integer", minimum: 0 }
        }
      }
    }
  }
};

function cleanText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function compactSegment(segment) {
  return {
    speaker: cleanText(segment?.speaker, 80) || "미등록 화자",
    start: Math.max(0, Number(segment?.start) || 0),
    end: Math.max(0, Number(segment?.end) || Number(segment?.start) || 0),
    text: cleanText(segment?.text, 10_000)
  };
}

export function transcriptHash(segments) {
  const normalized = (Array.isArray(segments) ? segments : []).map(compactSegment);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function validIndexes(value, total) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(Number).filter((index) => Number.isInteger(index) && index >= 0 && index < total))].sort((a, b) => a - b);
}

function localTopics(segments) {
  const topics = [];
  for (const [index, segment] of segments.entries()) {
    const previous = topics.at(-1);
    if (!previous || previous.segmentIndexes.length >= 4
      || segment.start - segments[previous.segmentIndexes.at(-1)].end > 12) {
      topics.push({
        label: cleanText(segment.text, 42) || `대화 구간 ${topics.length + 1}`,
        summary: cleanText(segment.text, 240),
        segmentIndexes: [index],
        subtopics: []
      });
    } else {
      previous.segmentIndexes.push(index);
      previous.summary = cleanText(`${previous.summary} ${segment.text}`, 240);
    }
  }
  return topics;
}

function normalizeResult(raw, segments, profile = {}) {
  const knownTerms = new Set((profile.knownTerms || []).map((term) => String(term).toLocaleLowerCase()));
  const topics = (Array.isArray(raw?.topics) ? raw.topics : []).map((topic) => {
    const segmentIndexes = validIndexes(topic?.segmentIndexes, segments.length);
    if (!segmentIndexes.length) return null;
    const referenced = segmentIndexes.map((index) => segments[index]);
    return {
      id: `topic-${segmentIndexes[0]}`,
      label: cleanText(topic.label, 80) || `대화 구간 ${segmentIndexes[0] + 1}`,
      summary: cleanText(topic.summary, 500),
      segmentIndexes,
      start: Math.min(...referenced.map(({ start }) => start)),
      end: Math.max(...referenced.map(({ end }) => end)),
      speakers: [...new Set(referenced.map(({ speaker }) => speaker))],
      subtopics: (Array.isArray(topic.subtopics) ? topic.subtopics : []).map((value) => cleanText(value, 80)).filter(Boolean)
    };
  }).filter(Boolean);

  const terms = (Array.isArray(raw?.terms) ? raw.terms : []).map((term) => {
    const index = Number(term?.evidenceSegmentIndex);
    const evidence = segments[index];
    const name = cleanText(term?.term, 80);
    if (!evidence || !name || knownTerms.has(name.toLocaleLowerCase())) return null;
    return {
      term: name,
      definition: cleanText(term.definition, 500),
      personalizedExplanation: cleanText(term.personalizedExplanation, 700),
      firstSeenAt: evidence.start,
      speaker: evidence.speaker,
      evidenceSegmentIndex: index
    };
  }).filter(Boolean);

  const actions = (Array.isArray(raw?.actions) ? raw.actions : []).map((action, index) => {
    const evidenceIndex = Number(action?.evidenceSegmentIndex);
    const evidence = segments[evidenceIndex];
    if (!evidence) return null;
    return {
      id: `action-${evidenceIndex}-${index}`,
      text: cleanText(action.text, 500) || evidence.text,
      owner: cleanText(action.owner, 80) || evidence.speaker,
      due: cleanText(action.due, 80) || "일정 미정",
      evidenceSegmentIndex: evidenceIndex,
      firstSeenAt: evidence.start
    };
  }).filter(Boolean);

  return {
    title: cleanText(raw?.title, 120) || "회의 분석",
    summary: cleanText(raw?.summary, 1200),
    topics: topics.length ? topics : localTopics(segments).map((topic) => {
      const referenced = topic.segmentIndexes.map((index) => segments[index]);
      return {
        ...topic,
        id: `topic-${topic.segmentIndexes[0]}`,
        start: referenced[0].start,
        end: referenced.at(-1).end,
        speakers: [...new Set(referenced.map(({ speaker }) => speaker))]
      };
    }),
    terms,
    actions
  };
}

function localAnalysis(segments, profile) {
  const actionPattern = /(오늘|내일|까지|담당|확인해|할게요|해주세요|합시다)/;
  const raw = {
    title: cleanText(segments[0]?.text, 48) || "회의 분석",
    summary: cleanText(segments.map(({ text }) => text).join(" "), 500),
    topics: localTopics(segments),
    terms: [],
    actions: segments.map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => actionPattern.test(segment.text))
      .map(({ segment, index }) => ({
        text: segment.text,
        owner: actionOwnerFromEvidence(segment.text, segment.speaker),
        due: actionDueFromEvidence(segment.text),
        evidenceSegmentIndex: index
      }))
  };
  return normalizeResult(raw, segments, profile);
}

function responseText(payload) {
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "output_text" && content.text) return content.text;
    }
  }
  return "";
}

export class MeetingIntelligenceService {
  constructor(options = {}) {
    this.apiKey = options.apiKey || "";
    this.model = options.model || "gpt-5.4-mini";
    this.fetch = options.fetch || globalThis.fetch;
  }

  get mode() {
    return this.apiKey ? "openai" : "local";
  }

  async analyze(meeting, profile = {}) {
    const segments = (meeting?.segments || []).map(compactSegment).filter(({ text }) => text);
    if (!segments.length) throw new Error("분석할 실제 발화가 없습니다.");
    if (!this.apiKey) return { ...localAnalysis(segments, profile), source: "local", model: null };

    const selected = [];
    let characters = 0;
    for (const [index, segment] of segments.entries()) {
      const line = `[${index}] ${segment.start.toFixed(2)}-${segment.end.toFixed(2)} ${segment.speaker}: ${segment.text}`;
      if (characters + line.length > 180_000) break;
      selected.push(line);
      characters += line.length;
    }
    const roles = (profile.roles || []).map((role) => cleanText(role, 40)).filter(Boolean);
    const knownTerms = (profile.knownTerms || []).map((term) => cleanText(term, 80)).filter(Boolean);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    let response;
    try {
      response = await this.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          store: false,
          reasoning: { effort: "low" },
          max_output_tokens: 5_000,
          instructions: "한국어 회의 분석기다. 제공된 실제 발화만 근거로 주제, 요약, 낯선 전문용어, 실행 항목을 만든다. 발화에 없는 사실·담당자·기한을 만들지 않는다. segmentIndexes와 evidenceSegmentIndex는 입력의 대괄호 번호만 사용한다. knownTerms는 제외하고 roles 관점에서 이해하기 쉽게 설명한다.",
          input: JSON.stringify({ roles, knownTerms, transcript: selected }),
          text: { format: { type: "json_schema", name: "meeting_intelligence", strict: true, schema: analysisSchema } }
        })
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const details = cleanText(await response.text(), 500);
      throw new Error(`회의 AI 분석 실패: HTTP ${response.status}${details ? ` · ${details}` : ""}`);
    }
    const payload = await response.json();
    const text = responseText(payload);
    if (!text) throw new Error("회의 AI 분석이 구조화된 결과를 반환하지 않았습니다.");
    const result = normalizeResult(JSON.parse(text), segments, profile);
    return {
      ...result,
      source: "openai",
      model: this.model,
      analyzedSegmentCount: selected.length,
      totalSegmentCount: segments.length
    };
  }
}
