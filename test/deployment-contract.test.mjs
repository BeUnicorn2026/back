import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production compose keeps the API private behind a restarting tunnel", async () => {
  const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
  assert.match(compose, /127\.0\.0\.1:7070:7070/);
  assert.match(compose, /mem_limit:\s*5g/);
  assert.match(compose, /cloudflare\/cloudflared/);
  assert.match(compose, /restart:\s*unless-stopped/g);
  assert.match(compose, /CLOUDFLARE_TUNNEL_TOKEN/);
  assert.match(compose, /condition:\s*service_healthy/);
});

test("updater only applies clean fast-forward changes", async () => {
  const updater = await readFile(new URL("../deploy/updater/update.sh", import.meta.url), "utf8");
  assert.match(updater, /git diff --quiet/);
  assert.match(updater, /git merge-base --is-ancestor/);
  assert.match(updater, /git merge --ff-only/);
  assert.match(updater, /docker compose[\s\S]*--detach --build --remove-orphans/);
});
