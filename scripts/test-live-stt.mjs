import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import WebSocket from "ws";

const [audioPath] = process.argv.slice(2);
const baseUrl = process.env.STT_TEST_URL || "http://localhost:3001";
const email = process.env.STT_TEST_EMAIL;
const password = process.env.STT_TEST_PASSWORD;
const mode = process.env.STT_TEST_MODE === "speaker" ? "speaker" : "stt";
const expectedSpeaker = String(process.env.STT_EXPECTED_SPEAKER || "").trim();
const testStartedAt = performance.now();

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: STT_TEST_EMAIL=... STT_TEST_PASSWORD=... npm run test:live-stt -- <audio-file>

Options:
  STT_TEST_URL       Backend URL (default: http://localhost:3001)
  STT_TEST_EMAIL     Existing account email
  STT_TEST_PASSWORD  Existing account password
  STT_TEST_MODE      stt (default) or speaker
  STT_EXPECTED_SPEAKER  Speaker name required in speaker-mode output`);
  process.exit(0);
}

if (!audioPath || !email || !password) {
  console.error("Usage: STT_TEST_EMAIL=... STT_TEST_PASSWORD=... node scripts/test-live-stt.mjs <audio-file>");
  process.exit(2);
}

function decodeToPcm(input) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn",
      "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"
    ]);
    const chunks = [];
    let errorText = "";
    ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => { errorText += chunk.toString(); });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(errorText.trim())));
    ffmpeg.stdin.end(input);
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const login = await fetch(new URL("/api/auth/login", baseUrl), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password })
});
if (!login.ok) throw new Error(`로그인 실패: ${login.status} ${await login.text()}`);
const loginCompletedAt = performance.now();
const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie")]).filter(Boolean)
  .map((value) => value.split(";", 1)[0]).join("; ");
const pcm = await decodeToPcm(await readFile(audioPath));
if (pcm.length < 16_000) throw new Error("오디오에 0.5초 이상의 실제 PCM 데이터가 필요합니다.");
const socketUrl = new URL(`/api/live?language=ko&mode=${mode}`, baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

const result = await new Promise((resolve, reject) => {
  const socket = new WebSocket(socketUrl, { headers: { Cookie: cookie } });
  const finalSegments = [];
  const preparationUpdates = [];
  let readyAt = null;
  let firstFinalAt = null;
  const maximumWait = mode === "speaker" ? 150_000 : 45_000;
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error(`실시간 ${mode === "speaker" ? "화자 식별" : "STT"} 테스트가 ${maximumWait / 1000}초 안에 끝나지 않았습니다.`));
  }, maximumWait);

  socket.on("message", async (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === "error") {
      clearTimeout(timeout);
      socket.close();
      return reject(new Error(event.message));
    }
    if (event.type !== "ready") {
      if (event.type === "preparing") preparationUpdates.push(event.elapsedSeconds || 0);
      if (event.type === "transcript" && event.isFinal) {
        firstFinalAt ||= performance.now();
        finalSegments.push(...(event.segments || []));
      }
      if (event.type === "finalized") {
        clearTimeout(timeout);
        socket.close(1000, "test complete");
        resolve({ finalSegments, preparationUpdates, readyAt, firstFinalAt, finalizedAt: performance.now() });
      }
      return;
    }
    if (event.mode !== mode) return reject(new Error(`예상하지 않은 모드: ${event.mode}`));
    readyAt = performance.now();
    for (let offset = 0; offset < pcm.length; offset += 3_200) {
      socket.send(pcm.subarray(offset, offset + 3_200));
      await delay(100);
    }
    socket.send(JSON.stringify({ type: "finalize" }));
  });
  socket.on("error", reject);
});

if (!result.finalSegments.length) throw new Error("확정된 STT 결과가 없습니다.");
if (expectedSpeaker && !result.finalSegments.some(({ speaker }) => speaker === expectedSpeaker)) {
  throw new Error(`예상 화자 ${expectedSpeaker}를 식별하지 못했습니다: ${result.finalSegments.map(({ speaker }) => speaker).join(", ")}`);
}
const milliseconds = (value) => value == null ? null : Math.round(value - testStartedAt);
console.log(JSON.stringify({
  mode,
  expectedSpeaker: expectedSpeaker || null,
  metricsMs: {
    login: Math.round(loginCompletedAt - testStartedAt),
    ready: milliseconds(result.readyAt),
    firstFinal: milliseconds(result.firstFinalAt),
    finalized: milliseconds(result.finalizedAt)
  },
  preparationUpdates: result.preparationUpdates,
  finalSegments: result.finalSegments
}, null, 2));
