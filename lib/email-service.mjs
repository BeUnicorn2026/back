function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}

export class EmailDeliveryError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "EmailDeliveryError";
    this.code = "EMAIL_DELIVERY_FAILED";
  }
}

export class VerificationEmailService {
  constructor(options = {}) {
    this.apiKey = options.apiKey || "";
    this.from = options.from || "";
    this.environment = options.environment || "development";
    this.fetch = options.fetch || globalThis.fetch;
  }

  get mode() {
    return this.apiKey ? "resend" : "console";
  }

  assertConfigured() {
    if (this.environment === "production" && (!this.apiKey || !this.from)) {
      throw new EmailDeliveryError("운영 환경에는 RESEND_API_KEY와 RESEND_FROM_EMAIL이 필요합니다.");
    }
  }

  async sendVerification({ email, name, code, expiresAt, idempotencyKey }) {
    this.assertConfigured();
    if (!this.apiKey) {
      console.log(JSON.stringify({
        level: "info", event: "development_verification_email", email, code, expiresAt
      }));
      return { provider: "console", developmentCode: code };
    }

    const safeName = escapeHtml(name || "사용자");
    const safeCode = escapeHtml(code);
    let response;
    try {
      response = await this.fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey
        },
        body: JSON.stringify({
          from: this.from,
          to: [email],
          subject: "ConThink 이메일 인증 코드",
          text: `${name || "사용자"}님, 인증 코드는 ${code}입니다. 이 코드는 10분 후 만료됩니다.`,
          html: `<div style="font-family:system-ui,-apple-system,sans-serif;background:#f6f8f5;padding:32px"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:20px;padding:32px"><p style="color:#39734f;font-weight:700;letter-spacing:.08em">ConThink</p><h1 style="font-size:28px;line-height:1.25">${safeName}님, 이메일을 확인해 주세요</h1><p style="color:#52605a;line-height:1.6">아래 6자리 코드를 가입 화면에 입력하세요. 코드는 10분 후 만료됩니다.</p><p style="font-size:36px;font-weight:750;letter-spacing:.18em;margin:28px 0">${safeCode}</p><p style="color:#69756f;font-size:13px">요청하지 않았다면 이 메일을 무시해 주세요.</p></div></div>`
        }),
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      throw new EmailDeliveryError("인증 이메일 전송 서비스에 연결하지 못했습니다.", error);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new EmailDeliveryError(payload?.message || payload?.error || "인증 이메일을 보내지 못했습니다.");
    }
    return { provider: "resend", messageId: payload.id || null };
  }
}
