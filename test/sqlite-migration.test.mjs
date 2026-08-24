import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthStore } from "../lib/auth-store.mjs";
import { MeetingStore } from "../lib/meeting-store.mjs";

test("imports legacy auth and meeting JSON once without modifying the source files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-sqlite-migration-"));
  const authDirectory = path.join(root, "auth");
  const meetingDirectory = path.join(root, "meetings");
  const databasePath = path.join(root, "voice-partition.sqlite");
  const sessionToken = "legacy-session-token";
  const future = new Date(Date.now() + 60_000).toISOString();
  const now = new Date().toISOString();
  const authState = JSON.stringify({
    version: 1,
    users: [{
      id: "user-legacy", name: "기존 사용자", email: "legacy@example.com",
      passwordHash: "scrypt$unused$unused", activeOrganizationId: "org-legacy",
      vocabulary: { roles: ["기획"], knownTerms: ["VAD"], onboardedAt: now },
      createdAt: now, updatedAt: now
    }],
    organizations: [{
      id: "org-legacy", name: "기존 조직", domain: "example.com", inviteCode: "LEGACY01",
      createdBy: "user-legacy", createdAt: now
    }],
    memberships: [{ userId: "user-legacy", organizationId: "org-legacy", role: "owner", joinedAt: now }],
    sessions: [{
      id: "session-legacy", userId: "user-legacy",
      tokenHash: createHash("sha256").update(sessionToken).digest("base64url"), expiresAt: future, createdAt: now
    }]
  }, null, 2);
  const meetingState = JSON.stringify({
    version: 1,
    meetings: [{
      id: "meeting-legacy", organizationId: "org-legacy", createdBy: "user-legacy",
      title: "기존 회의", language: "ko", source: "live", mode: "stt", status: "completed",
      segments: [{ id: "segment-legacy", speaker: "전사", known: false, confidence: null,
        sourceSpeaker: null, start: 0, end: 2.4, text: "기존 전사도 보존합니다." }],
      duration: 2.4, startedAt: now, endedAt: now, updatedAt: now
    }]
  }, null, 2);

  try {
    await Promise.all([mkdir(authDirectory), mkdir(meetingDirectory)]);
    await Promise.all([
      writeFile(path.join(authDirectory, "auth.json"), authState),
      writeFile(path.join(meetingDirectory, "meetings.json"), meetingState)
    ]);

    const authStore = new AuthStore(authDirectory, { databasePath });
    const meetingStore = new MeetingStore(meetingDirectory, { databasePath });
    await Promise.all([authStore.initialize(), meetingStore.initialize()]);

    const context = await authStore.getContextBySession(sessionToken);
    assert.equal(context.user.name, "기존 사용자");
    assert.equal(context.organization.id, "org-legacy");
    assert.deepEqual(context.user.vocabulary.knownTerms, ["VAD"]);
    const meetings = await meetingStore.list("org-legacy");
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0].segments[0].text, "기존 전사도 보존합니다.");

    await Promise.all([authStore.initialize(), meetingStore.initialize()]);
    assert.equal((await authStore.listMembers("user-legacy", "org-legacy")).length, 1);
    assert.equal((await meetingStore.list("org-legacy")).length, 1);
    assert.equal(await readFile(path.join(authDirectory, "auth.json"), "utf8"), authState);
    assert.equal(await readFile(path.join(meetingDirectory, "meetings.json"), "utf8"), meetingState);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
