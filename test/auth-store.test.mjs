import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthError, AuthStore } from "../lib/auth-store.mjs";

async function withStore(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voice-partition-auth-"));
  try {
    await run(new AuthStore(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function verifyNewUser(store, user, now = Date.now()) {
  const verification = await store.issueEmailVerification(user.id, { now });
  const verified = await store.verifyEmail(user.email, verification.code, { now: now + 1 });
  assert.ok(verified.emailVerifiedAt);
  return verification;
}

test("signup, session, organization creation and vocabulary persist", async () => {
  await withStore(async (store) => {
    const user = await store.signup({ name: "김민지", email: "minji@example.com", password: "secure-pass", introduction: "  회의 제품을 기획합니다.  " });
    await assert.rejects(store.authenticate("minji@example.com", "secure-pass"),
      (error) => error instanceof AuthError && error.code === "EMAIL_NOT_VERIFIED");
    await verifyNewUser(store, user);
    const authenticated = await store.authenticate("MINJI@example.com", "secure-pass");
    assert.equal(authenticated.id, user.id);
    assert.equal(authenticated.introduction, "회의 제품을 기획합니다.");

    const session = await store.createSession(user.id);
    const sessionContext = await store.getContextBySession(session.token);
    assert.equal(sessionContext.organization.name, "Unithon");
    assert.equal(sessionContext.csrfToken, session.csrfToken);
    assert.ok(session.csrfToken.length >= 40);

    const context = await store.createOrganization(user.id, { name: "Example Labs", domain: "example.com" });
    assert.equal(context.organization.name, "Example Labs");
    assert.equal(context.membership.role, "owner");

    const updated = await store.updateVocabulary(user.id, {
      roles: ["기획", "기획"], knownTerms: ["VAD", "임베딩"], onboarded: true
    });
    assert.deepEqual(updated.user.vocabulary.roles, ["기획"]);
    assert.ok(updated.user.vocabulary.onboardedAt);
  });
});

test("invite code joins a second user without exposing password hashes", async () => {
  await withStore(async (store) => {
    const owner = await store.signup({ name: "오너", email: "owner@acme.test", password: "secure-pass", introduction: "  회의 제품을 기획합니다.  " });
    await verifyNewUser(store, owner);
    const created = await store.createOrganization(owner.id, { name: "Acme", domain: "acme.test" });
    const member = await store.signup({ name: "멤버", email: "member@acme.test", password: "secure-pass", introduction: "  회의 제품을 기획합니다.  " });
    await verifyNewUser(store, member);
    const joined = await store.joinOrganization(member.id, created.organization.inviteCode.toLowerCase());
    assert.equal(joined.organization.id, created.organization.id);
    assert.equal(joined.membership.role, "member");
    assert.equal("passwordHash" in joined.user, false);
    assert.equal(joined.user.introduction, "회의 제품을 기획합니다.");
    const members = await store.listMembers(owner.id, created.organization.id);
    assert.equal(members.length, 2);
    assert.ok(members.every((listed) => !("introduction" in listed)));
  });
});

test("verification codes expire, limit guesses and can be replaced", async () => {
  await withStore(async (store) => {
    const user = await store.signup({ name: "검증 사용자", email: "verify@example.com", password: "secure-pass", introduction: "  회의 제품을 기획합니다.  " });
    const first = await store.issueEmailVerification(user.id, { now: 10_000 });
    await assert.rejects(store.issueEmailVerification(user.id, { now: 20_000 }),
      (error) => error instanceof AuthError && error.code === "VERIFICATION_COOLDOWN");
    await assert.rejects(store.verifyEmail(user.email, first.code, { now: 10_000 + 10 * 60_000 + 1 }),
      (error) => error instanceof AuthError && error.code === "VERIFICATION_EXPIRED");

    const replacement = await store.resendEmailVerification(user.email, "secure-pass", { now: 700_001 });
    const wrongCode = replacement.code === "000000" ? "000001" : "000000";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(store.verifyEmail(user.email, wrongCode, { now: 700_002 + attempt }),
        (error) => error instanceof AuthError && error.code === "INVALID_VERIFICATION_CODE");
    }
    await assert.rejects(store.verifyEmail(user.email, wrongCode, { now: 700_010 }),
      (error) => error instanceof AuthError && error.code === "VERIFICATION_ATTEMPTS_EXCEEDED");
    await assert.rejects(store.verifyEmail(user.email, replacement.code, { now: 700_011 }),
      (error) => error instanceof AuthError && error.code === "VERIFICATION_EXPIRED");
  });
});

test("verified email cannot create a fresh session through verification", async () => {
  await withStore(async (store) => {
    const user = await store.signup({
      name: "인증 사용자", email: "verified@example.com", password: "secure-pass", introduction: "보안 테스트"
    });
    const verification = await verifyNewUser(store, user, 10_000);
    await assert.rejects(store.verifyEmail(user.email, verification.code, { now: 10_002 }),
      (error) => error instanceof AuthError && error.status === 409 && error.code === "EMAIL_ALREADY_VERIFIED");
  });
});

test("signup introduction is required, profile updates are trimmed, and legacy null remains readable", async () => {
  await withStore(async (store) => {
    for (const introduction of [undefined, "   ", "가".repeat(501)]) {
      await assert.rejects(
        store.signup({ name: "소개 검증", email: `intro-${String(introduction).length}@example.com`, password: "secure-pass", introduction }),
        (error) => error instanceof AuthError && error.code === "INTRODUCTION_INVALID"
      );
    }

    const user = await store.signup({
      name: "소개 사용자", email: "introduction@example.com", password: "secure-pass", introduction: "첫 소개"
    });
    const updated = await store.updateProfile(user.id, { name: "  새 이름  ", introduction: "  갱신한 소개  " });
    assert.equal(updated.user.name, "새 이름");
    assert.equal(updated.user.introduction, "갱신한 소개");
    await assert.rejects(store.updateProfile(user.id, { introduction: "  " }),
      (error) => error instanceof AuthError && error.code === "INTRODUCTION_INVALID");
    await assert.rejects(store.updateProfile(user.id, { name: " ", introduction: "유효한 소개" }),
      (error) => error instanceof AuthError && error.code === "NAME_INVALID");
  });
});

test("duplicate email and invalid password are rejected", async () => {
  await withStore(async (store) => {
    await store.signup({ name: "사용자", email: "user@example.com", password: "secure-pass", introduction: "  회의 제품을 기획합니다.  " });
    await assert.rejects(
      store.signup({ name: "다른 사용자", email: "USER@example.com", password: "secure-pass", introduction: "  회의 제품을 기획합니다.  " }),
      (error) => error instanceof AuthError && error.status === 409
    );
    await assert.rejects(
      store.authenticate("user@example.com", "wrong-pass"),
      (error) => error instanceof AuthError && error.status === 401
    );
  });
});
