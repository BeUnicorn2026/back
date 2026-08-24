import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import WebSocket from "ws";

const [audioPath] = process.argv.slice(2);
const baseUrl = process.env.STT_TEST_URL || "http://localhost:3000";
const email = process.env.STT_TEST_EMAIL;
const password = process.env.STT_TEST_PASSWORD;
const mode = process.env.STT_TEST_MODE === "speaker" ? "speaker" : "stt";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: STT_TEST_EMAIL=... STT_TEST_PASSWORD=... npm run test:live-stt -- <audio-file>

Options:
  STT_TEST_URL       Service URL (default: http://localhost:3000)
  STT_TEST_EMAIL     Existing account email
  STT_TEST_PASSWORD  Existing account password
  STT_TEST_MODE      stt (default) or speaker`);
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
const cookie = (login.headers.getSetCookie?.() || [login.headers.get("set-cookie")]).filter(Boolean)
  .map((value) => value.split(";", 1)[0]).join("; ");
const pcm = await decodeToPcm(await readFile(audioPath));
if (pcm.length < 16_000) throw new Error("오디오에 0.5초 이상의 실제 PCM 데이터가 필요합니다.");
const socketUrl = new URL(`/api/live?language=ko&mode=${mode}`, baseUrl);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

const result = await new Promise((resolve, reject) => {
  const socket = new WebSocket(socketUrl, { headers: { Cookie: cookie } });
  const finalSegments = [];
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error("실시간 STT 테스트가 45초 안에 끝나지 않았습니다."));
  }, 45_000);

  socket.on("message", async (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === "error") {
      clearTimeout(timeout);
      socket.close();
      return reject(new Error(event.message));
    }
    if (event.type !== "ready") {
      if (event.type === "transcript" && event.isFinal) finalSegments.push(...(event.segments || []));
      if (event.type === "finalized") {
        clearTimeout(timeout);
        socket.close(1000, "test complete");
        resolve(finalSegments);
      }
      return;
    }
    if (event.mode !== mode) return reject(new Error(`예상하지 않은 모드: ${event.mode}`));
    for (let offset = 0; offset < pcm.length; offset += 3_200) {
      socket.send(pcm.subarray(offset, offset + 3_200));
      await delay(100);
    }
    socket.send(JSON.stringify({ type: "finalize" }));
  });
  socket.on("error", reject);
});

if (!result.length) throw new Error("확정된 STT 결과가 없습니다.");
console.log(JSON.stringify({ mode, finalSegments: result }, null, 2));
