function clean(value, maximum = 700) {
  return String(value || "").trim().slice(0, maximum);
}

export function aggregateVocabularyTerms(records, knownTerms = []) {
  const terms = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const meetingId = clean(record?.meetingId, 80);
    const updatedAt = clean(record?.updatedAt, 40);
    for (const source of Array.isArray(record?.result?.terms) ? record.result.terms : []) {
      const term = clean(source?.term, 80);
      if (!term) continue;
      const key = term.toLocaleLowerCase();
      const current = terms.get(key) || {
        term, definition: "", personalizedExplanation: "", occurrences: 0,
        meetingIds: new Set(), firstSeenAt: null, lastSeenAt: "", speakers: new Set()
      };
      current.occurrences += 1;
      if (meetingId) current.meetingIds.add(meetingId);
      if (source.speaker) current.speakers.add(clean(source.speaker, 80));
      const firstSeenAt = Number(source.firstSeenAt);
      if (Number.isFinite(firstSeenAt)) current.firstSeenAt = current.firstSeenAt == null ? firstSeenAt : Math.min(current.firstSeenAt, firstSeenAt);
      if (!current.lastSeenAt || updatedAt >= current.lastSeenAt) {
        current.definition = clean(source.definition, 500) || current.definition;
        current.personalizedExplanation = clean(source.personalizedExplanation, 700) || current.personalizedExplanation;
        current.lastSeenAt = updatedAt;
      }
      terms.set(key, current);
    }
  }

  const known = new Map((Array.isArray(knownTerms) ? knownTerms : [])
    .map((term) => [clean(term, 80).toLocaleLowerCase(), clean(term, 80)]).filter(([key]) => key));
  for (const [key, term] of known) {
    if (!terms.has(key)) {
      terms.set(key, {
        term, definition: "", personalizedExplanation: "", occurrences: 0,
        meetingIds: new Set(), firstSeenAt: null, lastSeenAt: "", speakers: new Set()
      });
    }
  }

  return [...terms.entries()].map(([key, value]) => ({
    term: value.term,
    definition: value.definition,
    personalizedExplanation: value.personalizedExplanation,
    occurrences: value.occurrences,
    meetingCount: value.meetingIds.size,
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt || null,
    speakers: [...value.speakers],
    isKnown: known.has(key)
  })).sort((left, right) => Number(left.isKnown) - Number(right.isKnown)
    || right.meetingCount - left.meetingCount || right.occurrences - left.occurrences || left.term.localeCompare(right.term, "ko"));
}
