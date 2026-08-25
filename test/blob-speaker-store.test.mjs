import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { BlobSpeakerStore } from "../lib/blob-speaker-store.mjs";

function memoryBlobClient() {
  const objects = new Map();
  return {
    objects,
    async put(pathname, body, options) {
      if (!options.allowOverwrite && objects.has(pathname)) throw new Error("already exists");
      objects.set(pathname, Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(String(body)));
      return { pathname };
    },
    async get(pathname) {
      const body = objects.get(pathname);
      return body ? { statusCode: 200, stream: new Response(body).body, blob: { pathname } } : null;
    },
    async list({ prefix }) {
      return {
        blobs: [...objects.keys()].filter((pathname) => pathname.startsWith(prefix)).map((pathname) => ({ pathname })),
        hasMore: false
      };
    },
    async del(pathnames) {
      for (const pathname of Array.isArray(pathnames) ? pathnames : [pathnames]) objects.delete(pathname);
    }
  };
}

const metadata = {
  id: "speaker-blob", name: "민수", organizationId: "org-a", createdBy: "user-a",
  createdAt: "2026-08-24T00:00:00.000Z", profileDimensions: 2
};

test("stores only encrypted speaker payloads in private Blob and restores profiles", async () => {
  const client = memoryBlobClient();
  const key = randomBytes(32).toString("base64");
  const store = new BlobSpeakerStore({ token: "test-token", encryptionKey: key, client });
  const profile = Buffer.from(new Float32Array([0.25, 0.75]).buffer);
  const reference = Buffer.from("RIFF private reference");
  const saved = await store.save(metadata, profile, reference);

  assert.equal(saved.storage.provider, "vercel-blob");
  assert.equal(saved.storage.access, "private");
  assert.equal(client.objects.size, 3);
  assert.equal([...client.objects.values()].some((value) => value.equals(profile) || value.equals(reference)), false);
  assert.deepEqual((await store.list("org-b")), []);
  const [loaded] = await store.loadProfiles("org-a");
  assert.deepEqual(Array.from(loaded.profile), [0.25, 0.75]);
  assert.deepEqual(loaded.referenceAudio, reference);

  const restarted = new BlobSpeakerStore({ token: "test-token", encryptionKey: key, client });
  await restarted.initialize();
  const wrongKey = new BlobSpeakerStore({ token: "test-token", encryptionKey: randomBytes(32).toString("base64"), client });
  await assert.rejects(() => wrongKey.initialize(), /인증에 실패/);
  assert.equal(await restarted.remove(metadata.id, "org-b"), false);
  assert.equal(await restarted.remove(metadata.id, "org-a"), true);
  assert.equal(client.objects.size, 0);
});

test("rolls back partial Blob uploads when enrollment fails", async () => {
  const client = memoryBlobClient();
  const originalPut = client.put;
  let writes = 0;
  client.put = async (...argumentsList) => {
    writes += 1;
    if (writes === 2) throw new Error("upload interrupted");
    return originalPut(...argumentsList);
  };
  const store = new BlobSpeakerStore({ token: "test-token", encryptionKey: randomBytes(32).toString("base64"), client });
  await assert.rejects(() => store.save(metadata, Buffer.alloc(8), Buffer.from("reference")), /upload interrupted/);
  assert.equal(client.objects.size, 0);
});

test("switches Blob profile versions after a complete replacement", async () => {
  const client = memoryBlobClient();
  const store = new BlobSpeakerStore({ token: "test-token", encryptionKey: randomBytes(32).toString("base64"), client });
  await store.save(metadata, Buffer.from(new Float32Array([1, 0]).buffer), Buffer.from("old-reference"));
  const before = (await store.list("org-a"))[0];
  assert.equal(await store.replace({ ...metadata, profileCount: 2 }, Buffer.alloc(8), Buffer.from("ignored"), "org-b"), null);
  const replaced = await store.replace({ ...metadata, profileCount: 2 }, Buffer.from(new Float32Array([0, 1]).buffer), Buffer.from("new-reference"), "org-a");
  assert.notEqual(replaced.storage.version, before.storage.version);
  assert.equal(client.objects.has(`voice-partition/speakers/${metadata.id}/${before.storage.profileFilename}`), false);
  const [loaded] = await store.loadProfiles("org-a");
  assert.deepEqual(Array.from(loaded.profile), [0, 1]);
  assert.deepEqual(loaded.referenceAudio, Buffer.from("new-reference"));
});

test("Blob replacement retries and surfaces obsolete biometric cleanup failure", async () => {
  const client = memoryBlobClient();
  const store = new BlobSpeakerStore({ token: "test-token", encryptionKey: randomBytes(32).toString("base64"), client });
  await store.save(metadata, Buffer.from(new Float32Array([1, 0]).buffer), Buffer.from("old"));
  let deleteCalls = 0;
  client.del = async () => { deleteCalls += 1; throw new Error("cleanup unavailable"); };
  await assert.rejects(() => store.replace(
    metadata, Buffer.from(new Float32Array([0, 1]).buffer), Buffer.from("new"), "org-a"
  ), (error) => error.code === "OBSOLETE_BIOMETRIC_CLEANUP_FAILED");
  assert.equal(deleteCalls, 3);
  assert.deepEqual(Array.from((await store.loadProfile(metadata.id, "org-a")).profile), [0, 1]);
});

test("Blob exact lookup avoids bulk listing and exact-owner operations reject missing ownership", async () => {
  const client = memoryBlobClient();
  const store = new BlobSpeakerStore({ token: "test-token", encryptionKey: randomBytes(32).toString("base64"), client });
  await store.save(metadata, Buffer.from(new Float32Array([1, 0]).buffer), Buffer.from("reference"));
  await store.save({ ...metadata, id: "legacy", createdBy: undefined }, Buffer.alloc(8), Buffer.from("legacy"));

  const originalList = client.list;
  client.list = async () => { throw new Error("bulk list must not run"); };
  assert.equal((await store.get(metadata.id, "org-a")).id, metadata.id);
  assert.equal(await store.get(metadata.id, "org-b"), null);
  assert.deepEqual(Array.from((await store.loadProfile(metadata.id, "org-a")).profile), [1, 0]);
  assert.equal(await store.loadOwnedProfile(metadata.id, "user-b"), null);
  assert.equal(await store.updateMetadataOwned("legacy", "user-a", { name: "claimed" }), null);
  assert.equal(await store.removeOwned("legacy", "user-a"), false);
  client.list = originalList;

  const replaced = await store.replace(
    { ...metadata, organizationId: "org-b", createdBy: "user-b", createdAt: "later" },
    Buffer.from(new Float32Array([0, 1]).buffer), Buffer.from("new"), "org-a"
  );
  assert.equal(replaced.organizationId, "org-a");
  assert.equal(replaced.createdBy, "user-a");
  assert.equal(replaced.createdAt, metadata.createdAt);
  assert.equal(await store.removeOwned(metadata.id, "user-b"), false);
  assert.equal(await store.removeOwned(metadata.id, "user-a"), true);
});

test("updates Blob verification metadata without changing payload versions", async () => {
  const client = memoryBlobClient();
  const store = new BlobSpeakerStore({ token: "test-token", encryptionKey: randomBytes(32).toString("base64"), client });
  await store.save(metadata, Buffer.from(new Float32Array([1, 0]).buffer), Buffer.from("reference"));
  const before = (await store.list("org-a"))[0];
  assert.equal(await store.updateMetadata(metadata.id, "org-b", { crossSessionVerificationCount: 1 }), null);
  const updated = await store.updateMetadata(metadata.id, "org-a", { crossSessionVerificationCount: 1 });
  assert.equal(updated.crossSessionVerificationCount, 1);
  assert.equal(updated.storage.version, before.storage.version);
  assert.equal(client.objects.size, 3);
});
