export const deepgramKeepAliveIntervalMs = 4_000;
export const deepgramIdleBeforeKeepAliveMs = 3_000;

export function createDeepgramKeepAlive(socket, options = {}) {
  const now = options.now || Date.now;
  const schedule = options.setInterval || setInterval;
  const cancel = options.clearInterval || clearInterval;
  const intervalMs = Math.max(1_000, Number(options.intervalMs) || deepgramKeepAliveIntervalMs);
  const idleMs = Math.max(1_000, Number(options.idleMs) || deepgramIdleBeforeKeepAliveMs);
  let lastAudioAt = now();
  let stopped = false;
  const timer = schedule(() => {
    if (stopped || socket?.readyState !== 1 || now() - lastAudioAt < idleMs) return;
    socket.send(JSON.stringify({ type: "KeepAlive" }));
  }, intervalMs);
  return {
    markAudioForwarded() {
      lastAudioAt = now();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancel(timer);
    }
  };
}

export function parseDeepgramLiveEvent(raw) {
  try {
    const event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : String(raw));
    return event && typeof event === "object" && !Array.isArray(event)
      ? { ok: true, event }
      : { ok: false, reason: "invalid_shape" };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
}

export function deepgramApplicationError(event) {
  if (!event || (event.type !== "Error" && !event.error && !event.err_code)) return null;
  const code = String(event.err_code || event.code || "PROVIDER_ERROR").replace(/[^A-Z0-9_-]/gi, "").slice(0, 40);
  return {
    code,
    message: `실시간 STT 제공자가 요청을 처리하지 못했습니다${code ? ` (${code})` : ""}. 잠시 후 다시 시도해 주세요.`
  };
}
