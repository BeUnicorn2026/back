import assert from "node:assert/strict";
import test from "node:test";
import { isSupportedAudioUpload } from "../lib/audio-upload.mjs";

test("accepts browser-specific MIME variants for supported audio files", () => {
  assert.equal(isSupportedAudioUpload({ mimetype: "audio/mpeg", originalname: "voice.mp3" }), true);
  assert.equal(isSupportedAudioUpload({ mimetype: "audio/x-m4a", originalname: "voice.m4a" }), true);
  assert.equal(isSupportedAudioUpload({ mimetype: "", originalname: "voice.WAV" }), true);
  assert.equal(isSupportedAudioUpload({ mimetype: "application/octet-stream", originalname: "meeting.webm" }), true);
});

test("does not trust a supported extension when the browser declares another content type", () => {
  assert.equal(isSupportedAudioUpload({ mimetype: "image/png", originalname: "voice.wav" }), false);
  assert.equal(isSupportedAudioUpload({ mimetype: "application/octet-stream", originalname: "payload.exe" }), false);
  assert.equal(isSupportedAudioUpload(null), false);
});
