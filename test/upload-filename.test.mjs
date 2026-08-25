import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUploadFilename, uploadTitle } from "../lib/upload-filename.mjs";

test("restores UTF-8 upload names decoded as latin1", () => {
  const mojibake = Buffer.from("실제 음성.wav", "utf8").toString("latin1");
  assert.equal(normalizeUploadFilename(mojibake), "실제 음성.wav");
  assert.equal(uploadTitle(mojibake), "실제 음성");
});

test("preserves ordinary names and valid Unicode when byte recovery is unsafe", () => {
  assert.equal(uploadTitle("interview.final.wav"), "interview.final");
  assert.equal(uploadTitle("회의.wav"), "회의");
  assert.equal(uploadTitle(""), "업로드한 회의");
});
