import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("VPB1");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER_LENGTH = MAGIC.length + IV_LENGTH + TAG_LENGTH;

export function parseEncryptionKey(value) {
  if (!value) return null;
  const input = String(value).trim();
  const key = /^[a-f0-9]{64}$/i.test(input) ? Buffer.from(input, "hex") : Buffer.from(input, "base64");
  if (key.length !== 32) throw new Error("VOICE_BIOMETRIC_KEY는 base64 또는 64자리 hex 형식의 32바이트 키여야 합니다.");
  return key;
}

export function encryptBlob(plaintext, key, context) {
  if (!Buffer.isBuffer(plaintext)) throw new TypeError("암호화 입력은 Buffer여야 합니다.");
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("AES-256-GCM에는 32바이트 키가 필요합니다.");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(String(context)));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBlob(payload, key, context) {
  if (!Buffer.isBuffer(payload) || payload.length < HEADER_LENGTH || !payload.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("지원되지 않는 암호화 파일 형식입니다.");
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("생체정보 복호화 키가 필요합니다.");
  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_LENGTH;
  const ciphertextStart = tagStart + TAG_LENGTH;
  const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(ivStart, tagStart), { authTagLength: TAG_LENGTH });
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(payload.subarray(tagStart, ciphertextStart));
  try {
    return Buffer.concat([decipher.update(payload.subarray(ciphertextStart)), decipher.final()]);
  } catch {
    throw new Error("생체정보 파일의 인증에 실패했습니다. 키가 다르거나 파일이 변조되었습니다.");
  }
}

export function isEncryptedBlob(payload) {
  return Buffer.isBuffer(payload) && payload.length >= HEADER_LENGTH && payload.subarray(0, MAGIC.length).equals(MAGIC);
}
