import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SpeakerStore } from "../lib/speaker-store.mjs";

const metadata = (id = "speaker-a") => ({
  id, name: "민수", organizationId: "org", createdBy: "user",
  createdAt: "2026-08-24T00:00:00.000Z", profileDimensions: 2
});

test("stores profiles and reference audio encrypted at rest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-secure-speakers-"));
  const key = randomBytes(32).toString("base64");
  const store = new SpeakerStore(root, { encryptionKey: key, requireEncryption: true });
  await store.initialize();
  const profile = Buffer.from(new Float32Array([0.25, 0.75]).buffer);
  const reference = Buffer.from("RIFF secret voice bytes");
  const saved = await store.save(metadata(), profile, reference);
  assert.equal(saved.encryptedAtRest, true);
  assert.deepEqual((await readdir(path.join(root, "speaker-a"))).sort(), ["profile.bin.enc", "reference.wav.enc", "speaker.json"]);

  const [loaded] = await store.loadProfiles("org");
  assert.deepEqual(Array.from(loaded.profile), [0.25, 0.75]);
  assert.deepEqual(loaded.referenceAudio, reference);
  assert.equal(loaded.encryptedAtRest, true);

  const wrongKeyStore = new SpeakerStore(root, { encryptionKey: randomBytes(32).toString("base64"), requireEncryption: true });
  await assert.rejects(() => wrongKeyStore.initialize(), /인증에 실패/);
});

test("atomically replaces a speaker profile only inside the organization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-replace-speakers-"));
  const store = new SpeakerStore(root, { encryptionKey: randomBytes(32).toString("base64") });
  await store.save(metadata(), Buffer.from(new Float32Array([1, 0]).buffer), Buffer.from("old-reference"));
  assert.equal(await store.replace({ ...metadata(), profileCount: 2 }, Buffer.from(new Float32Array([0, 1]).buffer), Buffer.from("new-reference"), "other-org"), null);
  const replaced = await store.replace({ ...metadata(), profileCount: 2 }, Buffer.from(new Float32Array([0, 1]).buffer), Buffer.from("new-reference"), "org");
  assert.equal(replaced.profileCount, 2);
  const [loaded] = await store.loadProfiles("org");
  assert.deepEqual(Array.from(loaded.profile), [0, 1]);
  assert.deepEqual(loaded.referenceAudio, Buffer.from("new-reference"));
  assert.equal((await readdir(root)).some((entry) => entry.includes("partial-") || entry.includes("backup-")), false);
});

test("updates verification metadata without rewriting biometric payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-metadata-speakers-"));
  const store = new SpeakerStore(root, { encryptionKey: randomBytes(32).toString("base64") });
  await store.save(metadata(), Buffer.from(new Float32Array([1, 0]).buffer), Buffer.from("reference"));
  assert.equal(await store.updateMetadata("speaker-a", "other-org", { crossSessionVerificationCount: 1 }), null);
  const updated = await store.updateMetadata("speaker-a", "org", { crossSessionVerificationCount: 1 });
  assert.equal(updated.crossSessionVerificationCount, 1);
  const [loaded] = await store.loadProfiles("org");
  assert.deepEqual(Array.from(loaded.profile), [1, 0]);
  assert.deepEqual(loaded.referenceAudio, Buffer.from("reference"));
});

test("keeps development compatibility but rejects plaintext in production mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-plain-speakers-"));
  const plainStore = new SpeakerStore(root);
  await plainStore.initialize();
  await plainStore.save(metadata(), Buffer.from(new Float32Array([1, 0]).buffer), Buffer.from("wave"));
  const [loaded] = await plainStore.loadProfiles("org");
  assert.equal(loaded.encryptedAtRest, false);

  const productionStore = new SpeakerStore(root, { encryptionKey: randomBytes(32).toString("base64"), requireEncryption: true });
  await assert.rejects(() => productionStore.initialize(), /평문 화자 프로필/);
  assert.throws(() => new SpeakerStore(root, { requireEncryption: true }), /반드시 필요/);
});

test("migrates plaintext only after an explicit commit and removes verified originals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-migrate-speakers-"));
  const plainStore = new SpeakerStore(root);
  await plainStore.save(metadata(), Buffer.from(new Float32Array([0.5, 0.5]).buffer), Buffer.from("reference"));
  const secureStore = new SpeakerStore(root, { encryptionKey: randomBytes(32).toString("base64") });
  const dryRun = await secureStore.migratePlaintext();
  assert.equal(dryRun.committed, false);
  assert.deepEqual((await readdir(path.join(root, "speaker-a"))).sort(), ["profile.bin", "reference.wav", "speaker.json"]);

  const result = await secureStore.migratePlaintext({ commit: true });
  assert.equal(result.migrated.length, 1);
  assert.deepEqual((await readdir(path.join(root, "speaker-a"))).sort(), ["profile.bin.enc", "reference.wav.enc", "speaker.json"]);
  const [loaded] = await secureStore.loadProfiles("org");
  assert.deepEqual(Array.from(loaded.profile), [0.5, 0.5]);
});
