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
