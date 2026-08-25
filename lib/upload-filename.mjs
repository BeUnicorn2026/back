export function normalizeUploadFilename(value, fallback = "업로드한 회의") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const decoded = Buffer.from(raw, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? raw : decoded;
}

export function uploadTitle(value) {
  return normalizeUploadFilename(value).replace(/\.[^.]+$/, "").trim() || "업로드한 회의";
}
