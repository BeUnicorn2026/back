import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptBlob, encryptBlob, isEncryptedBlob, parseEncryptionKey } from "../lib/secure-blob.mjs";

test("encrypts and authenticates biometric blobs with bound context", () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from("voice embedding bytes");
  const encrypted = encryptBlob(plaintext, key, "speaker-a:profile");
  assert.equal(isEncryptedBlob(encrypted), true);
  assert.notDeepEqual(encrypted, plaintext);
  assert.deepEqual(decryptBlob(encrypted, key, "speaker-a:profile"), plaintext);
  assert.throws(() => decryptBlob(encrypted, key, "speaker-b:profile"), /인증에 실패/);
  assert.throws(() => decryptBlob(encrypted, randomBytes(32), "speaker-a:profile"), /인증에 실패/);
});

test("accepts 32-byte base64 and hex keys only", () => {
  const key = randomBytes(32);
  assert.deepEqual(parseEncryptionKey(key.toString("base64")), key);
  assert.deepEqual(parseEncryptionKey(key.toString("hex")), key);
  assert.equal(parseEncryptionKey(""), null);
  assert.throws(() => parseEncryptionKey("short"), /32바이트/);
});
