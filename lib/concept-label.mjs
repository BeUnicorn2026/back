import { createHash } from "node:crypto";

// 용어 라벨 정리와 결정적 개념 ID 생성. 예전 knowledge-twin 모듈에서 유일하게
// 계속 쓰이는 부분만 남긴 것으로, 지식 상태 추적과는 무관한 순수 헬퍼다.

export function normalizeConceptLabel(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").slice(0, 80);
}

export function conceptIdFor(value) {
  const label = normalizeConceptLabel(value);
  if (!label) return "";
  const key = label.toLocaleLowerCase("ko-KR");
  return `concept_${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}
