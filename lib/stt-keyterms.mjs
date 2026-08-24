export function buildSttKeyterms({ knownTerms = [], organizationTerms = [], speakerNames = [] } = {}, limit = 100) {
  const terms = [];
  const seen = new Set();
  for (const value of [
    ...speakerNames,
    ...knownTerms,
    ...organizationTerms.map((item) => typeof item === "string" ? item : item?.term)
  ]) {
    const term = String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
    const key = term.toLocaleLowerCase();
    if (!term || term.length < 2 || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= limit) break;
  }
  return terms;
}
