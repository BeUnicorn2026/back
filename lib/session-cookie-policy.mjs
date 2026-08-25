const supportedSameSiteValues = new Set(["lax", "strict", "none"]);

function normalizedOrigin(value) {
  try {
    return new URL(String(value || "")).origin;
  } catch {
    return "";
  }
}

export function sessionCookiePolicy({ environment, configuredSameSite, serverOrigin, clientOrigin } = {}) {
  const production = environment === "production";
  const server = normalizedOrigin(serverOrigin);
  const client = normalizedOrigin(clientOrigin);
  const crossOriginClient = server && client && server !== client;
  const secureContext = server.startsWith("https://") && (!client || client.startsWith("https://"));
  const configured = String(configuredSameSite || "").toLocaleLowerCase();
  const requestedSameSite = crossOriginClient && secureContext
    ? "none"
    : supportedSameSiteValues.has(configured) ? configured : "lax";
  const sameSite = requestedSameSite === "none" && !secureContext ? "lax" : requestedSameSite;
  return { httpOnly: true, sameSite, secure: production || secureContext, path: "/" };
}
