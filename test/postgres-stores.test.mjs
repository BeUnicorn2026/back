import assert from "node:assert/strict";
import test from "node:test";
import { newDb } from "pg-mem";
import { AuthError } from "../lib/auth-store.mjs";
import { PostgresAuthStore } from "../lib/postgres-auth-store.mjs";
import { PostgresDatabase } from "../lib/postgres-database.mjs";
import { PostgresMeetingStore } from "../lib/postgres-meeting-store.mjs";
import { PostgresKnowledgeStore } from "../lib/postgres-knowledge-store.mjs";
import { PostgresRequestRateLimiter } from "../lib/postgres-rate-limiter.mjs";
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
    const owner = await store.signup({ name: "김민지", email: "minji@acme.test", password: "secure-pass" });
    await assert.rejects(store.authenticate(owner.email, "secure-pass"),
      (error) => error instanceof AuthError && error.code === "EMAIL_NOT_VERIFIED");
    const verification = await store.issueEmailVerification(owner.id, { now: 10_000 });
    await store.verifyEmail(owner.email, verification.code, { now: 10_001 });
    assert.equal((await store.authenticate("MINJI@acme.test", "secure-pass")).id, owner.id);

    const session = await store.createSession(owner.id);
    assert.equal((await store.getContextBySession(session.token)).csrfToken, session.csrfToken);
    const ownerContext = await store.createOrganization(owner.id, { name: "Acme", domain: "acme.test" });
    assert.equal(ownerContext.membership.role, "owner");
    const onboarded = await store.updateVocabulary(owner.id, {
      roles: ["기획", "기획"], knownTerms: ["VAD"], onboarded: true
    });
    assert.deepEqual(onboarded.user.vocabulary.roles, ["기획"]);

    const member = await verifiedUser(store,
      { name: "멤버", email: "member@acme.test", password: "secure-pass" }, 100_000);
    const joined = await store.joinOrganization(member.id, ownerContext.organization.inviteCode.toLowerCase());
    assert.equal(joined.organization.id, ownerContext.organization.id);
    assert.equal(joined.membership.role, "member");
    assert.equal((await store.listMembers(owner.id, ownerContext.organization.id)).length, 2);
    assert.equal("passwordHash" in joined.user, false);

    await assert.rejects(
      store.signup({ name: "중복", email: "MINJI@ACME.TEST", password: "secure-pass" }),
      (error) => error instanceof AuthError && error.code === "EMAIL_EXISTS"
    );
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
        { speaker: "민수", known: true, corrected: true, sourceSpeaker: "0", start: 0, end: 3.4, text: " 실제 회의를 저장합니다. " },
        { text: " " }
      ]
    });
    assert.equal(updated.title, "실제 회의를 저장합니다.");
    assert.equal(updated.segmentCount, 1);
    assert.equal(updated.status, "completed");
    assert.equal(updated.segments[0].corrected, true);
    assert.equal(updated.segments[0].confidence, null);
    assert.equal((await store.list("org-a")).length, 1);
    assert.equal((await store.list("org-b")).length, 0);
    assert.equal(await store.get(meeting.id, "org-b"), null);
    const hash = transcriptHash(updated.segments);
    await store.saveIntelligence({
      meetingId: meeting.id, organizationId: "org-a", transcriptHash: hash,
      source: "openai", model: "test-model", result: { title: "분석", topics: [], terms: [], actions: [] }
    });
    assert.equal((await store.getIntelligence(meeting.id, "org-a", hash)).model, "test-model");
    assert.equal(await store.getIntelligence(meeting.id, "org-b", hash), null);
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

test("PostgreSQL knowledge store keeps evidence idempotent and user-private", async () => {
  await withDatabase(async (database) => {
    const store = new PostgresKnowledgeStore(database);
    const first = await store.recordEvidence({
      userId: "user-a", conceptLabel: "임베딩", kind: "request_simpler",
      eventId: "knowledge-event-1", organizationId: "org-a", meetingId: "meeting-a", segmentIndex: 2
    });
    assert.equal(first.duplicate, false);
    assert.equal(first.state.status, "unknown");
    const duplicate = await store.recordEvidence({
      userId: "user-a", conceptLabel: "임베딩", kind: "request_simpler", eventId: "knowledge-event-1"
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.state.evidenceCount, 1);
    assert.equal((await store.list("user-b")).length, 0);
    assert.equal((await store.statesForTerms("user-a", ["임베딩"], [])).at(0).source, "evidence");
    const cacheKey = "b".repeat(64);
    const saved = await store.saveExplanation({
      userId: "user-a", cacheKey, conceptLabel: "임베딩", level: "simple",
      result: { explanation: "개인 설명", correctChoiceIndex: 2 }, source: "local"
    });
    assert.equal(saved.result.correctChoiceIndex, 2);
    assert.equal(await store.getExplanation("user-b", cacheKey), null);
    assert.equal((await store.getExplanation("user-a", cacheKey)).term, "임베딩");
    assert.equal(await store.claimExplanationAnswer("user-a", cacheKey, 2), true);
    assert.equal(await store.claimExplanationAnswer("user-a", cacheKey, 1), false);
    assert.equal((await store.getExplanation("user-a", cacheKey)).answeredChoiceIndex, 2);
  });
});
