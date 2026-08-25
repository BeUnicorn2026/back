function normalizedOrigin(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

export class GoMeetMapClient {
  constructor(options = {}) {
    this.origin = normalizedOrigin(options.origin);
    this.token = String(options.token || "").trim();
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || 10_000);
  }

  get enabled() {
    return Boolean(this.origin && this.token);
  }

  async submit({ meetingId, segments, tenantKey }) {
    return this.#request("/api/ai/meetmap/jobs", {
      method: "POST",
      tenantKey,
      body: { meetingId, segments }
    });
  }

  async get(jobId, tenantKey) {
    if (!/^map_[a-f0-9]{32}$/.test(String(jobId || ""))) throw new Error("잘못된 MeetMap 작업 ID입니다.");
    return this.#request(`/api/ai/meetmap/jobs/${jobId}`, { method: "GET", tenantKey });
  }

  async #request(path, { method, tenantKey, body }) {
    if (!this.enabled) {
      const error = new Error("Go MeetMap 서비스가 설정되지 않았습니다.");
      error.status = 503;
      throw error;
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
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || "Go MeetMap 요청을 완료하지 못했습니다.");
        error.status = response.status;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}
