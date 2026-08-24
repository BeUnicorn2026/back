import assert from "node:assert/strict";
import test from "node:test";
import { actionDueFromEvidence, actionOwnerFromEvidence } from "../lib/action-evidence.mjs";

test("action owner uses explicit named assignment instead of the current speaker", () => {
  assert.equal(actionOwnerFromEvidence("민수님이 내일까지 검증 결과를 확인해 주세요.", "지수"), "민수");
  assert.equal(actionOwnerFromEvidence("담당자는 서연입니다.", "지수"), "서연");
});

test("action owner uses the speaker only for explicit self commitments", () => {
  assert.equal(actionOwnerFromEvidence("제가 문서를 정리하겠습니다.", "지수"), "지수");
  assert.equal(actionOwnerFromEvidence("검토해 주세요.", "지수"), "담당 미정");
});

test("action due preserves only an explicitly spoken date expression", () => {
  assert.equal(actionDueFromEvidence("내일까지 확인해 주세요."), "내일까지");
  assert.equal(actionDueFromEvidence("8월 30일까지 공유하겠습니다."), "8월 30일까지");
  assert.equal(actionDueFromEvidence("검토해 주세요."), "일정 미정");
});
