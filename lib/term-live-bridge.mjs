import { conceptIdFor } from "./concept-label.mjs";
import { normalizeTermKey } from "./knowledge-personalization.mjs";

// 실시간 용어 푸시 브리지. 확정 자막 세그먼트를 2~3문장 청크로 묶어 Stage 1(공유
// 용어 추출)을 청크당 1회 호출하고, 새 용어가 나오면 참가자마다 Stage 2(자기소개
// 기반 필터)를 거쳐 그 사람에게 필요한 용어만 웹소켓으로 밀어 넣는다.
//
// livemap 브리지와 같은 불변 조건을 지킨다: 어떤 실패도 호출자에게 새어 나가지
// 않는다. handleFinalSegment는 절대 던지지 않고, 추출 실패는 해당 청크만 버리며,
// 필터 실패는 fail-open(전부 노출)으로 귀결된다. 자막 스트림은 항상 무사하다.

export function createNoopTermLiveBridge() {
  return {
    replayFinalSegment() {},
    handleFinalSegment() {},
    async finalize() { return null; },
    async dispose() {},
    get disabled() { return true; }
  };
}

const TERMINAL_SENTENCE = /[.!?…]/g;

export function createTermLiveBridge({
  extraction,
  filter,
  participants,
  meetingTopic = "",
  log = () => {},
  minSentences = 2,
  maxChunkChars = 280
} = {}) {
  const glossary = new Map();   // normalizeTermKey(term|alias) -> entry
  const definedTerms = [];      // Stage 1 프롬프트에 넘길 대표형+별칭 평탄화 목록
  let pending = null;           // { texts: [], sentences, chars, start, end, speaker }
  let chain = Promise.resolve();
  let finalized = false;
  let disposed = false;

  function listParticipants() {
    try {
      const listed = participants?.();
      return Array.isArray(listed) ? listed : [];
    } catch {
      return [];
    }
  }

  function registerEntry(entry) {
    const keys = [normalizeTermKey(entry.term), ...entry.aliases.map(normalizeTermKey)].filter(Boolean);
    for (const key of keys) glossary.set(key, entry);
    definedTerms.push(entry.term, ...entry.aliases);
  }

  function isDefined(term, aliases) {
    return [term, ...aliases].map(normalizeTermKey).filter(Boolean)
      .some((key) => glossary.has(key));
  }

  async function processChunk(chunk) {
    const result = await extraction.extract({
      meetingTopic,
      // 프롬프트 크기 제어: 가장 최근에 등록된 용어가 재등장 확률이 높다.
      definedTerms: definedTerms.slice(-120),
      chunk: chunk.text
    });
    const fresh = [];
    for (const candidate of result.terms || []) {
      if (isDefined(candidate.term, candidate.aliases)) continue;
      const entry = {
        conceptId: conceptIdFor(candidate.term),
        term: candidate.term,
        surface: candidate.surface,
        aliases: candidate.aliases,
        definition: candidate.definition,
        start: chunk.start,
        end: chunk.end,
        speaker: chunk.speaker
      };
      registerEntry(entry);
      fresh.push(entry);
    }
    if (!fresh.length) return;

    const snapshot = listParticipants();
    await Promise.all(snapshot.map(async (participant) => {
      // Stage 2: 자기소개 기반으로 이 참가자가 이미 아는 용어만 걸러낸다.
      // filter는 자체적으로 fail-open이지만, 여기서도 한 번 더 방어한다.
      let familiarKeys = new Set();
      try {
        const filtered = await filter.familiarTerms({
          userId: participant.userId,
          introduction: participant.introduction || "",
          candidateTerms: fresh.map(({ term }) => term)
        });
        if (filtered?.familiarKeys instanceof Set) familiarKeys = filtered.familiarKeys;
      } catch { /* fail-open */ }
      const known = new Set((participant.knownTerms || []).map(normalizeTermKey).filter(Boolean));
      const visible = fresh.filter((entry) => {
        if (familiarKeys.has(normalizeTermKey(entry.term))) return false;
        // 명시적 knownTerms는 별칭 표기로 등록돼 있어도 같은 용어로 취급한다.
        return ![entry.term, ...entry.aliases].map(normalizeTermKey).filter(Boolean)
          .some((key) => known.has(key));
      });
      if (!visible.length) return;
      try {
        participant.send({
          type: "term_batch",
          sentAt: new Date().toISOString(),
          payload: { terms: visible }
        });
      } catch { /* 한 참가자의 소켓 오류가 다른 참가자를 막으면 안 된다. */ }
    }));
  }

  function enqueueChunk(chunk) {
    chain = chain
      .then(() => processChunk(chunk))
      .catch(() => {
        // 계약: 추출 실패는 해당 청크만 폐기하고 스트림은 계속 간다.
        log({ event: "term_chunk_discarded" });
      });
  }

  function flushPending() {
    if (!pending || !pending.texts.length) {
      pending = null;
      return null;
    }
    const chunk = {
      text: pending.texts.join(" "),
      start: pending.start,
      end: pending.end,
      speaker: pending.speaker
    };
    pending = null;
    return chunk;
  }

  function handleFinalSegment(segment) {
    if (finalized || disposed) return;
    try {
      const text = String(segment?.text || "").trim();
      if (!text) return;
      const start = Number(segment?.start) || 0;
      const end = Math.max(start, Number(segment?.end) || 0);
      if (!pending) {
        pending = { texts: [], sentences: 0, chars: 0, start, end, speaker: String(segment?.speaker || "").trim() || "화자" };
      }
      pending.texts.push(text);
      // STT가 문장부호를 안 붙이는 경우가 있어 세그먼트 하나를 최소 1문장으로 센다.
      pending.sentences += Math.max(1, (text.match(TERMINAL_SENTENCE) || []).length);
      pending.chars += text.length;
      pending.end = end;
      if (pending.sentences >= minSentences || pending.chars >= maxChunkChars) {
        const chunk = flushPending();
        if (chunk) enqueueChunk(chunk);
      }
    } catch { /* 자막 흐름을 절대 방해하지 않는다. */ }
  }

  // 재접속 리플레이는 과거 기록 복원용이라 재추출·재푸시하지 않는다.
  function replayFinalSegment() {}

  async function finalize() {
    if (finalized) return null;
    finalized = true;
    const chunk = flushPending();
    if (chunk) enqueueChunk(chunk);
    await chain.catch(() => {});
    return { definedTermCount: definedTerms.length };
  }

  async function dispose() {
    disposed = true;
    finalized = true;
    pending = null;
  }

  return {
    replayFinalSegment,
    handleFinalSegment,
    finalize,
    dispose,
    get disabled() { return false; }
  };
}
