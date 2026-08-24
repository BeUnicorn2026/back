const selfReferencePattern = /(?:^|[\s,])(제가|저는|내가|나는)(?:[\s,]|$)/;
const selfCommitmentPattern = /(제가|저는|내가|나는).*(?:할게요|하겠습니다|맡겠습니다|진행하겠습니다)/;
const namedAssignmentPatterns = [
  /(?:담당(?:자)?(?:는|은|:)?\s*)([가-힣A-Za-z][가-힣A-Za-z0-9_-]{0,19})(?:님|씨)?(?:입니다|이에요|예요|로|으로|가|이|는|은|\s|$)/,
  /(?:^|[\s,])([가-힣A-Za-z][가-힣A-Za-z0-9_-]{0,19})(?:님|씨)(?:이|가|께서)?\s.*(?:해\s*주세요|해주세요|확인|담당|진행|작성|공유|정리|검토)/,
  /(?:^|[\s,])([가-힣A-Za-z][가-힣A-Za-z0-9_-]{0,19})(?:이|가|께서)\s.*(?:해\s*주세요|해주세요|확인|담당|진행|작성|공유|정리|검토)/
];

function cleanName(value) {
  return String(value || "").trim().replace(/(?:님|씨)$/, "").slice(0, 20);
}

export function actionOwnerFromEvidence(text, speaker) {
  const value = String(text || "").trim();
  if (selfCommitmentPattern.test(value) || (selfReferencePattern.test(value) && /(?:담당|진행|작성|공유|정리|검토|확인)/.test(value))) {
    return cleanName(speaker) || "담당 미정";
  }
  for (const pattern of namedAssignmentPatterns) {
    const match = value.match(pattern);
    if (match?.[1]) return cleanName(match[1]) || "담당 미정";
  }
  if (/(?:할게요|하겠습니다|맡겠습니다|진행하겠습니다)/.test(value)) {
    return cleanName(speaker) || "담당 미정";
  }
  return "담당 미정";
}

export function actionDueFromEvidence(text) {
  const value = String(text || "");
  const absolute = value.match(/(?:20\d{2}년\s*)?\d{1,2}월\s*\d{1,2}일(?:까지)?/);
  if (absolute) return absolute[0].replace(/\s+/g, " ");
  const relative = value.match(/(?:오늘|내일|모레|이번\s*주|다음\s*주)(?:까지|안에|내로)?/);
  if (relative) return relative[0].replace(/\s+/g, " ");
  const weekday = value.match(/(?:이번\s*주|다음\s*주)?\s*(?:월|화|수|목|금|토|일)요일(?:까지)?/);
  if (weekday) return weekday[0].trim().replace(/\s+/g, " ");
  const dayOnly = value.match(/(?:^|\s)(\d{1,2}일(?:까지)?)(?:\s|$)/);
  return dayOnly?.[1] || "일정 미정";
}
