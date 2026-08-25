import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newDb } from "pg-mem";
import { PostgresDatabase } from "../lib/postgres-database.mjs";
import { PostgresVoiceProfileStore } from "../lib/postgres-voice-profile-store.mjs";
import { VoiceProfileStore } from "../lib/voice-profile-store.mjs";

const initial = (overrides = {}) => ({
  userId: "user-a",
  speakerProfileId: "profile-a",
  enrollmentOrganizationId: "org-enrolled",
  now: "2026-08-25T00:00:00.000Z",
  ...overrides
});

async function sqliteStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "voice-profile-index-"));
  return new VoiceProfileStore(path.join(directory, "database.sqlite"));
}

async function withPostgres(run) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  try {
    await run(new PostgresVoiceProfileStore(new PostgresDatabase({ pool })));
  } finally {
    await pool.end();
  }
}

async function canonicalStoreContract(store) {
  await store.initialize();
  const [winner, loser] = await Promise.all([
    store.publishInitial(initial()),
    store.publishInitial(initial({ speakerProfileId: "losing-staged-payload" }))
  ]);
  assert.equal([winner.status, loser.status].filter((status) => status === "published").length, 1);
  const failedPublish = winner.status === "conflict" ? winner : loser;
  assert.equal(failedPublish.status, "conflict");
  assert.equal(failedPublish.reason, "user-already-has-profile");
  assert.equal(failedPublish.profile.userId, "user-a");

  const current = await store.getByUserId("user-a");
  const replacementId = "profile-replacement";
  const replaced = await store.replace(initial({
    speakerProfileId: replacementId,
    expectedVersion: current.version,
    now: "2026-08-25T00:01:00.000Z"
  }));
  assert.equal(replaced.status, "replaced");
  assert.equal(replaced.profile.version, 2);

  const stale = await store.replace(initial({
    speakerProfileId: "stale-staged-payload",
    expectedVersion: current.version
  }));
  assert.equal(stale.status, "conflict");
  assert.equal(stale.reason, "version-mismatch");
  assert.equal(stale.profile.speakerProfileId, replacementId);

  const fromAnotherOrganization = await store.getStatus({
    userId: "user-a",
    currentOrganizationId: "org-current",
    membership: { role: "member" }
  });
  assert.equal(fromAnotherOrganization.authorized, true);
  assert.equal(fromAnotherOrganization.profile.enrollmentOrganizationId, "org-enrolled");
  assert.equal((await store.getStatus({
    userId: "user-a", currentOrganizationId: "org-current", membership: null
  })).authorized, false);

  const invalid = await store.markInvalid({ userId: "user-a", expectedVersion: 2 });
  assert.equal(invalid.profile.state, "invalid");
  assert.equal(invalid.profile.version, 3);
  assert.equal((await store.deletePointer({ userId: "user-a", expectedVersion: 2 })).status, "conflict");
  assert.equal((await store.deletePointer({ userId: "user-a", expectedVersion: 3 })).status, "deleted");
}

test("SQLite canonical voice profile index publishes staged pointers race-safely and uses CAS", async () => {
  await canonicalStoreContract(await sqliteStore());
});

test("PostgreSQL canonical voice profile index publishes staged pointers race-safely and uses CAS", async () => {
  await withPostgres(canonicalStoreContract);
});

test("legacy migration claims only one explicitly owned candidate", async () => {
  const store = await sqliteStore();
  assert.equal((await store.claimLegacyCandidate({
    userId: "user-a",
    candidates: [{ id: "unowned", organizationId: "org", name: "user-a" }]
  })).status, "no-candidate");
  assert.equal((await store.claimLegacyCandidate({
    userId: "user-a",
    candidates: [
      { id: "owned-a", organizationId: "org", createdBy: "user-a" },
      { id: "owned-b", organizationId: "org", createdBy: "user-a" }
    ]
  })).status, "ambiguous");
  const claimed = await store.claimLegacyCandidate({
    userId: "user-a",
    candidates: [
      { id: "unowned", organizationId: "org", name: "user-a" },
      { id: "owned", organizationId: "org", createdBy: "user-a" }
    ]
  });
  assert.equal(claimed.status, "published");
  assert.equal(claimed.profile.speakerProfileId, "owned");
});
