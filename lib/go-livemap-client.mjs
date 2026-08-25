function normalizedOrigin(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

// Explicit opt-in: per-turn LiveMap calls stream meeting content to an external
// LLM and cost money, so the feature stays off unless LIVEMAP_ENABLED is the
// literal string "true" AND both the Go origin and bearer token are configured.
export function isLiveMapEnabled(env = process.env) {
  return env?.LIVEMAP_ENABLED === "true"
    && Boolean(String(env?.GO_AI_ORIGIN || "").trim())
    && Boolean(String(env?.AI_API_TOKEN || "").trim());
}

export class LiveMapError extends Error {
  constructor(message, { status = 0, code = "livemap_error" } = {}) {
    super(message || "LiveMap 요청을 완료하지 못했습니다.");
    this.name = "LiveMapError";
    this.status = status;
    this.code = code;
  }
}

// Thin typed client for the Go real-time livemap session API. Control-plane
// calls only (the Go side does LLM work asynchronously), so timeouts are short
// and there is deliberately no retry loop here — the bridge decides how to react
// to a typed failure. Mirrors GoMeetMapClient's fetch/timeout/tenant conventions.
export class GoLiveMapClient {
  constructor(options = {}) {
    this.origin = normalizedOrigin(options.origin);
    this.token = String(options.token || "").trim();
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 5_000);
  }

  get enabled() {
    return Boolean(this.origin && this.token);
  }

  async createSession({ meetingId = "", agenda = [], tenantKey } = {}) {
    return this.#request("/api/ai/livemap/sessions", {
      method: "POST",
      tenantKey,
      body: { meetingId: String(meetingId || ""), agenda: Array.isArray(agenda) ? agenda : [] }
    });
  }

  async postTurn(sessionId, turn, tenantKey) {
    return this.#request(`/api/ai/livemap/sessions/${encodeURIComponent(String(sessionId || ""))}/turns`, {
      method: "POST",
      tenantKey,
      body: {
        turnId: String(turn?.turnId || ""),
        speaker: String(turn?.speaker || ""),
        text: String(turn?.text || ""),
        start: Number(turn?.start) || 0,
        end: Number(turn?.end) || 0
      }
    });
  }

  async getSession(sessionId, sinceSeq, tenantKey) {
    const seq = Number(sinceSeq);
    const query = Number.isFinite(seq) ? `?sinceSeq=${seq}` : "";
    return this.#request(`/api/ai/livemap/sessions/${encodeURIComponent(String(sessionId || ""))}${query}`, {
      method: "GET",
      tenantKey
    });
  }

  async finalizeSession(sessionId, tenantKey) {
    return this.#request(`/api/ai/livemap/sessions/${encodeURIComponent(String(sessionId || ""))}/finalize`, {
      method: "POST",
      tenantKey
    });
  }

  // DELETE tolerates 204 (deleted) and 404 (already gone) as success — teardown
  // is best-effort and must never surface a hard error to the caller.
  async deleteSession(sessionId, tenantKey) {
    return this.#request(`/api/ai/livemap/sessions/${encodeURIComponent(String(sessionId || ""))}`, {
      method: "DELETE",
      tenantKey,
      okStatuses: [204, 404]
    });
  }

  async #request(path, { method, tenantKey, body, okStatuses }) {
    if (!this.enabled) {
      throw new LiveMapError("LiveMap 서비스가 설정되지 않았습니다.", { status: 503, code: "disabled" });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.origin}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "X-Voice-Partition-Tenant": String(tenantKey || "")
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (Array.isArray(okStatuses) && okStatuses.includes(response.status)) {
        return { status: response.status };
      }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new LiveMapError(payload.error || "LiveMap 요청을 완료하지 못했습니다.", {
          status: response.status,
          code: payload.code || "http_error"
        });
      }
      return { status: response.status, ...payload };
    } finally {
      clearTimeout(timeout);
    }
  }
}
