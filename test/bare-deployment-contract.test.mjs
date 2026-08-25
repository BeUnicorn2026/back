import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const deploymentFile = (name) => readFile(new URL(`../deploy/bare/${name}`, import.meta.url), "utf8");

test("bare deployment stays inside Unicorn and limits the backend to one gigabyte", async () => {
  const service = await deploymentFile("voice-partition.service");
  assert.match(service, /WorkingDirectory=%h\/Unicorn\/current/);
  assert.match(service, /EnvironmentFile=%h\/Unicorn\/config\/backend\.env/);
  assert.match(service, /MemoryMax=1G/);
  assert.match(service, /--max-old-space-size=512/);
  assert.match(service, /Restart=always/);
});

test("bare updater deploys immutable releases and only accepts fast-forward updates", async () => {
  const updater = await deploymentFile("update.sh");
  assert.match(updater, /merge-base --is-ancestor/);
  assert.match(updater, /git -C "\$source_repository" archive/);
  assert.match(updater, /npm ci --omit=dev/);
  assert.match(updater, /mv -Tf "\$base\/current\.next" "\$base\/current"/);
  assert.doesNotMatch(updater, /reset --hard/);
});

test("bare update timer runs once per minute with a smaller memory budget", async () => {
  const timer = await deploymentFile("voice-partition-update.timer");
  const service = await deploymentFile("voice-partition-update.service");
  assert.match(timer, /OnUnitActiveSec=60s/);
  assert.match(service, /MemoryMax=640M/);
});
