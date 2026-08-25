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
  const crossOriginProductionClient = production && server && client && server !== client;
  const configured = String(configuredSameSite || "").toLocaleLowerCase();
  const sameSite = crossOriginProductionClient
    ? "none"
    : supportedSameSiteValues.has(configured) ? configured : "lax";
  return { httpOnly: true, sameSite, secure: production, path: "/" };
}
