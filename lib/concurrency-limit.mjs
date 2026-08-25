export function createConcurrencyLimit(limitValue, options = {}) {
  const limit = Math.max(1, Math.floor(Number(limitValue) || 1));
  let active = 0;
  return function concurrencyLimit(_request, response, next) {
    if (active >= limit) {
      response.set("Retry-After", String(options.retryAfterSeconds || 10));
      return response.status(503).json({
        error: options.message || "동시에 처리 중인 요청이 많습니다. 잠시 후 다시 시도해 주세요.",
        code: options.code || "SERVICE_BUSY"
      });
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  };
}
