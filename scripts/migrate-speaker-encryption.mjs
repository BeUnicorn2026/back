import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { SpeakerStore } from "../lib/speaker-store.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: npm run migrate:speaker-encryption -- [--commit]

Without --commit, prints a dry-run plan and changes nothing.
With --commit, encrypts each profile and reference WAV, verifies authentication,
then removes the plaintext profile.bin and reference.wav files.

Required environment variable: VOICE_BIOMETRIC_KEY`);
  process.exit(0);
}

const projectDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDirectory = process.env.VOICE_PARTITION_DATA_DIR
  ? path.resolve(process.env.VOICE_PARTITION_DATA_DIR)
  : path.join(projectDirectory, ".data");
const store = new SpeakerStore(path.join(dataDirectory, "speakers"), {
  encryptionKey: process.env.VOICE_BIOMETRIC_KEY
});
const result = await store.migratePlaintext({ commit: process.argv.includes("--commit") });
console.log(JSON.stringify(result, null, 2));
if (!result.committed && result.plan.some(({ plaintextFiles }) => plaintextFiles.length)) {
  console.error("Dry run only. Back up VOICE_BIOMETRIC_KEY, then rerun with --commit.");
}
