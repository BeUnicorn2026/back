import path from "node:path";

const supportedMimeTypes = new Set([
  "audio/aac", "audio/flac", "audio/m4a", "audio/mp3", "audio/mp4", "audio/mpeg",
  "audio/ogg", "audio/wav", "audio/webm", "audio/x-m4a", "audio/x-wav",
  "video/mp4", "video/webm"
]);

const supportedExtensions = new Set([".aac", ".flac", ".m4a", ".mp3", ".mp4", ".ogg", ".wav", ".webm"]);
const genericMimeTypes = new Set(["", "application/octet-stream"]);

export function isSupportedAudioUpload(file) {
  if (!file) return false;
  const mimeType = String(file.mimetype || "").trim().toLocaleLowerCase();
  if (supportedMimeTypes.has(mimeType)) return true;
  if (!genericMimeTypes.has(mimeType)) return false;
  return supportedExtensions.has(path.extname(String(file.originalname || "")).toLocaleLowerCase());
}
