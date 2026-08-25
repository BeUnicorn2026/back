import assert from "node:assert/strict";
import test from "node:test";
import { sessionCookiePolicy } from "../lib/session-cookie-policy.mjs";

test("uses a secure cross-origin session cookie for a separately deployed production frontend", () => {
  assert.deepEqual(sessionCookiePolicy({
    environment: "production",
    configuredSameSite: "lax",
    serverOrigin: "https://voice-api.example.net",
    clientOrigin: "https://voice-partition.pages.dev"
  }), { httpOnly: true, sameSite: "none", secure: true, path: "/" });
});

test("keeps same-origin and development sessions lax unless explicitly configured", () => {
  assert.equal(sessionCookiePolicy({
    environment: "production",
    serverOrigin: "https://app.example.com",
    clientOrigin: "https://app.example.com"
  }).sameSite, "lax");
  assert.deepEqual(sessionCookiePolicy({
    environment: "development",
    configuredSameSite: "auto",
    serverOrigin: "http://localhost:3001",
    clientOrigin: "http://localhost:3000"
  }), { httpOnly: true, sameSite: "lax", secure: false, path: "/" });
});

test("marks a cross-origin HTTPS session secure even when the local service uses development diagnostics", () => {
  assert.deepEqual(sessionCookiePolicy({
    environment: "development",
    configuredSameSite: "none",
    serverOrigin: "https://api.ssu-on.com",
    clientOrigin: "https://unithon.ssu-on.com"
  }), { httpOnly: true, sameSite: "none", secure: true, path: "/" });
});

test("does not emit a browser-invalid SameSite None cookie over local HTTP", () => {
  assert.deepEqual(sessionCookiePolicy({
    environment: "development",
    configuredSameSite: "none",
    serverOrigin: "http://localhost:7071",
    clientOrigin: "http://localhost:5173"
  }), { httpOnly: true, sameSite: "lax", secure: false, path: "/" });
});
