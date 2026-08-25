export class TossPaymentsError extends Error {
  constructor(message, code = "PAYMENT_PROVIDER_ERROR", status = 502) {
    super(message);
    this.name = "TossPaymentsError";
    this.code = code;
    this.status = status;
  }
}

export class TossPaymentsClient {
  constructor({ clientKey, secretKey, fetchImpl = fetch } = {}) {
    this.clientKey = String(clientKey || "").trim();
    this.secretKey = String(secretKey || "").trim();
    this.fetchImpl = fetchImpl;
  }

  get mode() {
    if (!this.clientKey || !this.secretKey) return "disabled";
    return this.clientKey.startsWith("test_") && this.secretKey.startsWith("test_") ? "test" : "live";
  }

  publicConfiguration() {
    return { enabled: this.mode !== "disabled", mode: this.mode, clientKey: this.clientKey || null };
  }

  async confirm({ paymentKey, orderId, amount }) {
    if (this.mode === "disabled") {
      throw new TossPaymentsError("결제 테스트 키가 아직 서버에 설정되지 않았습니다.", "PAYMENT_NOT_CONFIGURED", 503);
    }
    const authorization = Buffer.from(`${this.secretKey}:`, "utf8").toString("base64");
    let response;
    try {
      response = await this.fetchImpl("https://api.tosspayments.com/v1/payments/confirm", {
        method: "POST",
        headers: {
          Authorization: `Basic ${authorization}`,
          "Content-Type": "application/json",
          "Idempotency-Key": orderId
        },
        body: JSON.stringify({ paymentKey, orderId, amount }),
        signal: AbortSignal.timeout(15_000)
      });
    } catch (cause) {
      throw new TossPaymentsError("결제 승인 서버에 연결하지 못했습니다.", "PAYMENT_PROVIDER_UNREACHABLE", 502, { cause });
    }
    let payload = {};
    try { payload = await response.json(); } catch { /* provider returned no usable JSON */ }
    if (!response.ok) {
      const safeMessage = response.status >= 500
        ? "결제 승인 서버가 일시적으로 응답하지 않습니다."
        : String(payload.message || "결제를 승인하지 못했습니다.").slice(0, 200);
      throw new TossPaymentsError(safeMessage, String(payload.code || "PAYMENT_CONFIRM_FAILED"), response.status);
    }
    if (payload.orderId !== orderId || Number(payload.totalAmount) !== Number(amount) || payload.status !== "DONE") {
      throw new TossPaymentsError("결제 승인 결과가 주문 정보와 일치하지 않습니다.", "PAYMENT_RESULT_MISMATCH", 502);
    }
    return payload;
  }
}
