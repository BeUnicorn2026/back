// Mirror Go strings.TrimSpace / the front-end mergeSegments trim: strip leading
// and trailing Unicode whitespace so a blank segment is detected identically.
function trimUnicode(value) {
  return String(value ?? "").replace(/^\s+|\s+$/gu, "");
}

function toFloat(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// Server-side turn assembly. It MUST mirror front/src/features/recording
// useRecording.js mergeSegments: consecutive FINAL segments with the SAME
// speaker and a gap (next.start - current.end) strictly less than gapSeconds are
// merged into one turn, so a live turn matches the segment the user sees.
//
// Pure and stateful: push(finalSegment) -> { finalizedTurn | null } returns the
// PREVIOUS turn when the incoming segment starts a new one; flush() -> the last
// pending turn. Blank/whitespace-only segments are skipped. A blank speaker
// defaults to "화자". turnId is deterministic per builder instance: turn-1,
// turn-2, ... A finalized turn is { turnId, speaker, text, start, end } where
// text is the space-joined segment texts.
export function createTurnBuilder({ gapSeconds = 1.25 } = {}) {
  const gap = Number.isFinite(Number(gapSeconds)) ? Number(gapSeconds) : 1.25;
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

  function push(segment) {
    const text = trimUnicode(segment?.text);
    if (!text) return { finalizedTurn: null };
    const speaker = trimUnicode(segment?.speaker) || "화자";
    const start = toFloat(segment?.start);
    const end = Math.max(start, toFloat(segment?.end));

    if (current && current.speaker === speaker && start - current.end < gap) {
      current.parts.push(text);
      current.end = end;
      return { finalizedTurn: null };
    }
    const finalizedTurn = finalizeCurrent();
    current = { turnId: `turn-${++turnCount}`, speaker, parts: [text], start, end };
    return { finalizedTurn };
  }

  function flush() {
    return { finalizedTurn: finalizeCurrent() };
  }

  function discardPending() {
    current = null;
  }

  return { push, flush, discardPending };
}
