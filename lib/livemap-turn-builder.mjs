// Mirror Go strings.TrimSpace / the front-end mergeSegments trim: strip leading
// and trailing Unicode whitespace so a blank segment is detected identically.
function trimUnicode(value) {
  return String(value ?? "").replace(/^\s+|\s+$/gu, "");
}

function toFloat(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function syllableCount(text) {
  return [...text.replace(/\s+/gu, "")].length;
}

function wordCount(text) {
  return text.split(/\s+/u).filter(Boolean).length;
}

// Server-side turn assembly for the live IBIS tree. STT finals can slice speech
// mid-sentence (짧은 조각·긴 침묵), and cutting there gives Call A fragments it
// cannot tag and Call B bad parents. So a turn keeps absorbing consecutive
// same-speaker FINAL segments — regardless of silence gaps — and is finalized at
// the first NATURAL word boundary (a segment end; finals never split a word)
// after any of these thresholds is crossed:
//   - duration  >= 20 seconds
//   - syllables >= 80 (whitespace excluded)
//   - words     >= 30 (어절)
// A speaker change always finalizes the previous turn, since a turn belongs to
// one speaker.
//
// Pure and stateful: push(finalSegment) -> { finalizedTurns: Turn[] } returns
// every turn completed by that segment (previous speaker's turn and/or the
// current turn that just crossed a threshold); flush() -> { finalizedTurn }
// returns the last pending turn. Blank/whitespace-only segments are skipped. A
// blank speaker defaults to "화자". turnId is deterministic per builder
// instance: turn-1, turn-2, ... A finalized turn is { turnId, speaker, text,
// start, end } where text is the space-joined segment texts.
export function createTurnBuilder({
  maxDurationSeconds = 20,
  maxSyllables = 80,
  maxWords = 30
} = {}) {
  const durationLimit = Number.isFinite(Number(maxDurationSeconds)) ? Number(maxDurationSeconds) : 20;
  const syllableLimit = Number.isFinite(Number(maxSyllables)) ? Number(maxSyllables) : 80;
  const wordLimit = Number.isFinite(Number(maxWords)) ? Number(maxWords) : 30;
  let current = null;
  let turnCount = 0;

  function finalizeCurrent() {
    if (!current) return null;
    const turn = {
      turnId: current.turnId,
      speaker: current.speaker,
      text: current.parts.join(" "),
      start: current.start,
      end: current.end
    };
    current = null;
    return turn;
  }

  function overThreshold() {
    return current.end - current.start >= durationLimit
      || current.syllables >= syllableLimit
      || current.words >= wordLimit;
  }

  function push(segment) {
    const text = trimUnicode(segment?.text);
    if (!text) return { finalizedTurns: [] };
    const speaker = trimUnicode(segment?.speaker) || "화자";
    const start = toFloat(segment?.start);
    const end = Math.max(start, toFloat(segment?.end));
    const finalizedTurns = [];

    if (current && current.speaker !== speaker) {
      finalizedTurns.push(finalizeCurrent());
    }
    if (current) {
      current.parts.push(text);
      current.end = end;
    } else {
      current = { turnId: `turn-${++turnCount}`, speaker, parts: [text], start, end, syllables: 0, words: 0 };
    }
    current.syllables += syllableCount(text);
    current.words += wordCount(text);
    // 임계 초과 시 바로 확정한다: 세그먼트 끝은 항상 어절이 끝난 지점이므로
    // "자연스러운 단어 종결 시" 조건이 자동으로 지켜진다.
    if (overThreshold()) finalizedTurns.push(finalizeCurrent());
    return { finalizedTurns };
  }

  function flush() {
    return { finalizedTurn: finalizeCurrent() };
  }

  function discardPending() {
    current = null;
  }

  return { push, flush, discardPending };
}
