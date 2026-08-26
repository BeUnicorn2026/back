import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { AuthError } from "../lib/auth-store.mjs";
import { PostgresAuthStore } from "../lib/postgres-auth-store.mjs";
import { PostgresDatabase } from "../lib/postgres-database.mjs";
import { PostgresMeetingStore } from "../lib/postgres-meeting-store.mjs";
import { PostgresRequestRateLimiter } from "../lib/postgres-rate-limiter.mjs";
import { PostgresBillingStore } from "../lib/postgres-billing-store.mjs";
import { transcriptHash } from "../lib/meeting-intelligence.mjs";

async function withDatabase(run) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const database = new PostgresDatabase({ pool });
  try {
    await run(database);
  } finally {
    await pool.end();
  }
}

async function verifiedUser(store, details, now = Date.now()) {
  const user = await store.signup(details);
  const verification = await store.issueEmailVerification(user.id, { now });
  await store.verifyEmail(user.email, verification.code, { now: now + 1 });
  return user;
}

test("PostgreSQL auth store supports the complete organization onboarding flow", async () => {
  await withDatabase(async (database) => {
    const store = new PostgresAuthStore(database, { verificationSecret: "test-verification-secret" });
    const owner = await store.signup({ name: "김민지", email: "minji@acme.test", password: "secure-pass", introduction: "  데이터 제품을 기획합니다.  " });
    await assert.rejects(store.authenticate(owner.email, "secure-pass"),
      (error) => error instanceof AuthError && error.code === "EMAIL_NOT_VERIFIED");
    const verification = await store.issueEmailVerification(owner.id, { now: 10_000 });
    await store.verifyEmail(owner.email, verification.code, { now: 10_001 });
    await assert.rejects(store.verifyEmail(owner.email, verification.code, { now: 10_002 }),
      (error) => error instanceof AuthError && error.code === "EMAIL_ALREADY_VERIFIED");
    const authenticated = await store.authenticate("MINJI@acme.test", "secure-pass");
    assert.equal(authenticated.id, owner.id);
    assert.equal(authenticated.introduction, "데이터 제품을 기획합니다.");

    const session = await store.createSession(owner.id);
    assert.equal((await store.getContextBySession(session.token)).csrfToken, session.csrfToken);
    const ownerContext = await store.createOrganization(owner.id, { name: "Acme", domain: "acme.test" });
    assert.equal(ownerContext.membership.role, "owner");
    const onboarded = await store.updateVocabulary(owner.id, {
      roles: ["기획", "기획"], knownTerms: ["VAD"], onboarded: true
    });
    assert.deepEqual(onboarded.user.vocabulary.roles, ["기획"]);

    const member = await verifiedUser(store,
      { name: "멤버", email: "member@acme.test", password: "secure-pass", introduction: "  데이터 제품을 기획합니다.  " }, 100_000);
    const joined = await store.joinOrganization(member.id, ownerContext.organization.inviteCode.toLowerCase());
    assert.equal(joined.organization.id, ownerContext.organization.id);
    assert.equal(joined.membership.role, "member");
    const members = await store.listMembers(owner.id, ownerContext.organization.id);
    assert.equal(members.length, 2);
    assert.ok(members.every((listed) => !("introduction" in listed)));
    assert.equal("passwordHash" in joined.user, false);

    const updated = await store.updateProfile(owner.id, { name: "  새 오너  ", introduction: "  백엔드 프로필  " });
    assert.equal(updated.user.name, "새 오너");
    assert.equal(updated.user.introduction, "백엔드 프로필");
    await assert.rejects(store.updateProfile(owner.id, { introduction: "가".repeat(501) }),
      (error) => error instanceof AuthError && error.code === "INTRODUCTION_INVALID");

    await assert.rejects(
      store.signup({ name: "중복", email: "MINJI@ACME.TEST", password: "secure-pass", introduction: "  데이터 제품을 기획합니다.  " }),
      (error) => error instanceof AuthError && error.code === "EMAIL_EXISTS"
    );
    await assert.rejects(
      store.signup({ name: "소개 없음", email: "empty@acme.test", password: "secure-pass", introduction: "  " }),
      (error) => error instanceof AuthError && error.code === "INTRODUCTION_INVALID"
    );

    await database.query("UPDATE users SET introduction = NULL WHERE id = $1", [member.id]);
    const legacySession = await store.createSession(member.id);
    assert.equal((await store.getContextBySession(legacySession.token)).user.introduction, null);
  });
});

test("PostgreSQL meeting store persists segments and isolates organizations", async () => {
  await withDatabase(async (database) => {
    const store = new PostgresMeetingStore(database);
    const meeting = await store.create({
      organizationId: "org-a", createdBy: "user-a", source: "live", language: "ko", mode: "stt"
    });
    const updated = await store.update(meeting.id, "org-a", {
      status: "completed",
      duration: 3.4,
      segments: [
        { speaker: "민수", known: true, corrected: true, transcriptCorrected: true, transcriptConfidence: 0.84, sourceSpeaker: "0", start: 0, end: 3.4, text: " 실제 회의를 저장합니다. " },
        { text: " " }
      ]
    });
    assert.equal(updated.title, "실제 회의를 저장합니다.");
    assert.equal(updated.segmentCount, 1);
    assert.equal(updated.status, "completed");
    assert.equal(updated.segments[0].corrected, true);
    assert.equal(updated.segments[0].transcriptCorrected, true);
    assert.equal(updated.segments[0].confidence, null);
    assert.equal(updated.segments[0].transcriptConfidence, 0.84);
    const staleAutosave = await store.update(meeting.id, "org-a", {
      status: "recording",
      duration: 1,
      segments: [{ speaker: "민수", start: 0, end: 1, text: "오래된 자동 저장" }]
    });
    assert.equal(staleAutosave.status, "completed");
    assert.equal(staleAutosave.duration, 3.4);
    assert.equal(staleAutosave.segments[0].text, "실제 회의를 저장합니다.");
    assert.equal((await store.list("org-a")).length, 1);
    assert.equal((await store.list("org-b")).length, 0);
    assert.equal(await store.countSince("org-a", "2000-01-01T00:00:00.000Z"), 1);
    assert.equal(await store.countSince("org-a", "2999-01-01T00:00:00.000Z"), 0);
    assert.equal(await store.get(meeting.id, "org-b"), null);
    const hash = transcriptHash(updated.segments);
    await store.saveIntelligence({
      meetingId: meeting.id, organizationId: "org-a", transcriptHash: hash,
      source: "openai", model: "test-model", result: { title: "분석", topics: [], terms: [], actions: [] }
    });
    assert.equal((await store.getIntelligence(meeting.id, "org-a", hash)).model, "test-model");
    assert.equal((await store.get(meeting.id, "org-a")).title, "분석");
    assert.equal(await store.getIntelligence(meeting.id, "org-b", hash), null);
    assert.equal(await store.remove(meeting.id, "org-b"), false);
    assert.equal(await store.remove(meeting.id, "org-a"), true);
    assert.equal(await store.get(meeting.id, "org-a"), null);
    assert.equal(await store.getIntelligence(meeting.id, "org-a", hash), null);
  });
});

test("PostgreSQL meeting store reuses active room meetings and sequences accepted segments", async () => {
  await withDatabase(async (database) => {
    const store = new PostgresMeetingStore(database);
    const roomId = "00000000-0000-4000-8000-000000000001";
    const first = await store.create({ organizationId: "org", createdBy: "user", roomId });
    const replay = await store.create({ organizationId: "org", createdBy: "user", roomId });
    assert.equal(replay.id, first.id);
    const one = await store.appendAcceptedSegment(first.id, "org", {
      userId: "user-a", speakerProfileId: "profile-a", start: 0, end: 1, text: "첫 구간"
    });
    const two = await store.appendAcceptedSegment(first.id, "org", {
      userId: null, speakerProfileId: null, start: 1, end: 2, text: "둘째 구간"
    });
    assert.deepEqual([one.sequence, two.sequence].sort(), [0, 1]);
    const loaded = await store.get(first.id, "org");
    assert.equal(loaded.roomId, roomId);
    assert.deepEqual(loaded.segments.map(({ sequence }) => sequence), [0, 1]);
    assert.equal(loaded.segments.find(({ userId }) => userId)?.speakerProfileId, "profile-a");
    const unsafeAutosave = await store.update(first.id, "org", {
      duration: 8,
      segments: [{ speaker: "공격자", start: 0, end: 8, text: "전체 대화 덮어쓰기" }]
    });
    assert.equal(unsafeAutosave.duration, 8);
    assert.deepEqual(unsafeAutosave.segments.map(({ text }) => text), ["첫 구간", "둘째 구간"]);
  });
});

test("PostgreSQL meeting store creates completed uploads atomically", async () => {
  await withDatabase(async (database) => {
    const store = new PostgresMeetingStore(database);
    await assert.rejects(store.createCompleted({ organizationId: "org", createdBy: "user", segments: [] }),
      /대화 내용/);
    assert.equal((await store.list("org")).length, 0);
    const meeting = await store.createCompleted({
      organizationId: "org", createdBy: "user", title: "인터뷰.wav", importKey: "9aebfbe1-6436-4996-8ee5-46ff80ade67d",
      segments: [{ speaker: "민수", start: 0, end: 5.5, text: "원자적으로 저장합니다." }]
    });
    assert.equal(meeting.status, "completed");
    assert.equal(meeting.duration, 5.5);
    assert.equal(meeting.segmentCount, 1);
    const duplicate = await store.createCompleted({
      organizationId: "org", createdBy: "user", importKey: "9aebfbe1-6436-4996-8ee5-46ff80ade67d",
      segments: [{ text: "중복" }]
    });
    assert.equal(duplicate.id, meeting.id);
    assert.equal((await store.list("org")).length, 1);
    assert.equal((await store.getByImportKey("org", "9aebfbe1-6436-4996-8ee5-46ff80ade67d")).id, meeting.id);
  });
});

test("PostgreSQL rate limiter shares an atomic fixed window", async () => {
  await withDatabase(async (database) => {
    const limiter = new PostgresRequestRateLimiter(database);
    const attempts = await Promise.all(Array.from({ length: 12 }, () =>
      limiter.consume("login:address:user", { limit: 5, windowMs: 1_000, now: 10_000 })));
    assert.equal(attempts.filter(({ allowed }) => allowed).length, 5);
    assert.equal(Math.min(...attempts.map(({ remaining }) => remaining)), 0);
    assert.equal((await limiter.consume("login:address:user", { limit: 5, windowMs: 1_000, now: 11_001 })).allowed, true);
  });
});

test("PostgreSQL billing store reserves meeting quota atomically", async () => {
  await withDatabase(async (database) => {
    await database.query("CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE organizations (id TEXT PRIMARY KEY)");
    await database.query("INSERT INTO users (id) VALUES ('user-a'); INSERT INTO organizations (id) VALUES ('org-a')");
    const store = new PostgresBillingStore(database);
    const parameters = {
      organizationId: "org-a", periodStart: "2026-08-01T00:00:00.000Z", limit: 2, baselineUsed: 0
    };
    const results = await Promise.all([
      store.consumeMeeting({ ...parameters, usageKey: "meeting-a" }),
      store.consumeMeeting({ ...parameters, usageKey: "meeting-b" })
    ]);
    assert.deepEqual(results.map(({ used }) => used).sort(), [1, 2]);
    assert.equal((await store.consumeMeeting({ ...parameters, usageKey: "meeting-a" })).duplicate, true);
    await assert.rejects(store.consumeMeeting({ ...parameters, usageKey: "meeting-c" }),
      (error) => error.code === "PLAN_MEETING_LIMIT");
    assert.equal(await store.releaseMeeting({ ...parameters, usageKey: "meeting-b" }), true);
    assert.equal((await store.consumeMeeting({ ...parameters, usageKey: "meeting-c" })).used, 2);
  });
});
