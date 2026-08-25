import "dotenv/config";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import WebSocket, { WebSocketServer } from "ws";
import { AuthError, AuthStore } from "./lib/auth-store.mjs";
import { analyzePcmQuality, isSpeakerInferenceQuality, isSpeakerSignalQuality } from "./lib/audio-quality.mjs";
import { normalizeTranscript } from "./lib/normalize-transcript.mjs";
import { assessNewSpeakerSeparation, assessSpeakerProfileExtension, getSpeakerEmbeddingModel, mergeSpeakerProfileVectors, speakerInferenceInfo, speakerModelInfo } from "./lib/speaker-embedding-model.mjs";
import { diarizedAudioRegions, speakerDecision, SpeakerIdentityTracker, wordsToSegments, wordsToTranscriptSegments } from "./lib/speaker-matching.mjs";
import { SpeakerAudioAccumulator } from "./lib/speaker-audio-accumulator.mjs";
import { SpeakerStore } from "./lib/speaker-store.mjs";
import { MeetingStore } from "./lib/meeting-store.mjs";
import { reconcileTranscriptSpeakers } from "./lib/reconcile-speakers.mjs";
import { RequestRateLimiter } from "./lib/request-rate-limiter.mjs";
import { closeSqliteDatabases, openSqliteDatabase } from "./lib/sqlite-database.mjs";
import { EmailDeliveryError, VerificationEmailService } from "./lib/email-service.mjs";
import { BlobSpeakerStore } from "./lib/blob-speaker-store.mjs";
import { PostgresDatabase, closePostgresDatabases } from "./lib/postgres-database.mjs";
import { PostgresAuthStore } from "./lib/postgres-auth-store.mjs";
import { PostgresMeetingStore } from "./lib/postgres-meeting-store.mjs";
import { PostgresRequestRateLimiter } from "./lib/postgres-rate-limiter.mjs";
import { MeetingIntelligenceService, transcriptHash } from "./lib/meeting-intelligence.mjs";
import { PcmHistoryBuffer } from "./lib/pcm-history-buffer.mjs";
import { buildSttKeyterms } from "./lib/stt-keyterms.mjs";
import { KnowledgeStore } from "./lib/knowledge-store.mjs";
import { PostgresKnowledgeStore } from "./lib/postgres-knowledge-store.mjs";
import { knowledgeTwinDefaults, normalizeConceptLabel } from "./lib/knowledge-twin.mjs";
import { personalizeKnowledgeTerms } from "./lib/knowledge-personalization.mjs";
import { KnowledgeExplanationService, knowledgeExplanationCacheKey } from "./lib/knowledge-explanation.mjs";
import { normalizeUploadFilename, uploadTitle } from "./lib/upload-filename.mjs";
import { productionEnvironmentIssues, serviceReadiness } from "./lib/service-readiness.mjs";
import { createConcurrencyLimit } from "./lib/concurrency-limit.mjs";
import { recordingEnvelopeSimilarity, speakerProbeFingerprint, speakerVerificationUpdate } from "./lib/speaker-verification.mjs";

const app = express();
const port = Number(process.env.PORT) || 3001;
const projectDirectory = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.VOICE_PARTITION_DATA_DIR
  ? path.resolve(process.env.VOICE_PARTITION_DATA_DIR)
  : path.join(projectDirectory, ".data");
const databasePath = process.env.VOICE_PARTITION_DATABASE_PATH
  ? path.resolve(process.env.VOICE_PARTITION_DATABASE_PATH)
  : path.join(dataDirectory, "voice-partition.sqlite");
const missingProductionVariables = productionEnvironmentIssues(process.env.NODE_ENV, process.env);
if (missingProductionVariables.length) {
  throw new Error(`운영 환경 설정이 필요합니다: ${missingProductionVariables.join(", ")}`);
}
const emailVerificationSecret = process.env.EMAIL_VERIFICATION_SECRET
  || (process.env.NODE_ENV === "production" ? "" : "voice-partition-development-verification-secret");
const databaseMode = process.env.DATABASE_URL ? "postgresql" : "sqlite";
const postgresDatabase = databaseMode === "postgresql"
  ? new PostgresDatabase({
    connectionString: process.env.DATABASE_URL,
    maximumConnections: process.env.POSTGRES_POOL_MAX
  })
  : null;
const authStore = postgresDatabase
  ? new PostgresAuthStore(postgresDatabase, { verificationSecret: emailVerificationSecret })
  : new AuthStore(path.join(dataDirectory, "auth"), { databasePath, verificationSecret: emailVerificationSecret });
const speakerStorageMode = process.env.SPEAKER_STORAGE === "blob" || process.env.BLOB_READ_WRITE_TOKEN
  ? "vercel-blob"
  : "local";
const speakerStore = speakerStorageMode === "vercel-blob"
  ? new BlobSpeakerStore({
    token: process.env.BLOB_READ_WRITE_TOKEN,
    prefix: process.env.BLOB_SPEAKER_PREFIX,
    encryptionKey: process.env.VOICE_BIOMETRIC_KEY
  })
  : new SpeakerStore(path.join(dataDirectory, "speakers"), {
    encryptionKey: process.env.VOICE_BIOMETRIC_KEY,
    requireEncryption: process.env.NODE_ENV === "production"
  });
const meetingStore = postgresDatabase
  ? new PostgresMeetingStore(postgresDatabase)
  : new MeetingStore(path.join(dataDirectory, "meetings"), { databasePath });
const knowledgeStore = postgresDatabase
  ? new PostgresKnowledgeStore(postgresDatabase)
  : new KnowledgeStore(databasePath);
const requestRateLimiter = postgresDatabase
  ? new PostgresRequestRateLimiter(postgresDatabase)
  : new RequestRateLimiter(databasePath);
const emailService = new VerificationEmailService({
  apiKey: process.env.RESEND_API_KEY,
  from: process.env.RESEND_FROM_EMAIL,
  environment: process.env.NODE_ENV
});
emailService.assertConfigured();
const meetingIntelligenceService = new MeetingIntelligenceService({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_ANALYSIS_MODEL
});
const knowledgeExplanationService = new KnowledgeExplanationService({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_EXPLANATION_MODEL || process.env.OPENAI_ANALYSIS_MODEL
});
const speakerModelCache = process.env.SPEAKER_MODEL_CACHE || path.join(projectDirectory, ".cache", "speaker-models");
const speakerModelPath = process.env.SPEAKER_MODEL_PATH || "";
const shouldPreloadSpeakerModel = process.env.PRELOAD_SPEAKER_MODEL === "true"
  || (process.env.NODE_ENV === "production" && process.env.PRELOAD_SPEAKER_MODEL !== "false");
let speakerModelState = "idle";
let speakerModelFailure = null;

async function prepareSpeakerModel() {
  if (speakerModelState !== "ready") speakerModelState = "loading";
  try {
    const model = await getSpeakerEmbeddingModel(speakerModelCache, speakerModelPath);
    speakerModelState = "ready";
    speakerModelFailure = null;
    return model;
  } catch (error) {
    speakerModelState = "failed";
    speakerModelFailure = error;
    throw error;
  }
}
const maxAudioBytes = 25 * 1024 * 1024;
const supportedMimeTypes = new Set([
  "audio/flac", "audio/m4a", "audio/mp3", "audio/mp4", "audio/mpeg",
  "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm", "video/mp4", "video/webm"
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxAudioBytes, files: 1 },
  fileFilter(_request, file, callback) {
    callback(null, supportedMimeTypes.has(file.mimetype));
  }
});

const sessionCookieName = "voice_partition_session";

if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : process.env.TRUST_PROXY);

function requestOrigin(request) {
  const protocol = request.headers["x-forwarded-proto"]?.split(",", 1)[0]?.trim() || (request.socket.encrypted ? "https" : "http");
  return `${protocol}://${request.headers.host}`;
}

function allowedOrigins(request) {
  const configured = String(process.env.PUBLIC_ORIGIN || "").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
  return configured.length ? configured : [requestOrigin(request)];
}

function hasTrustedOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return allowedOrigins(request).some((allowed) => new URL(origin).origin === new URL(allowed).origin);
  } catch {
    return false;
  }
}

function requireTrustedOrigin(request, response, next) {
  if (!hasTrustedOrigin(request)) {
    return response.status(403).json({ error: "허용되지 않은 요청 출처입니다.", code: "ORIGIN_REJECTED" });
  }
  next();
}

function safeTokenEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function requireCsrf(request, response, next) {
  if (!safeTokenEqual(request.headers["x-csrf-token"], request.auth?.csrfToken)) {
    return response.status(403).json({ error: "보안 토큰이 만료됐습니다. 페이지를 새로고침해 주세요.", code: "CSRF_INVALID" });
  }
  next();
}

function rateLimit(scope, options, identify) {
  return async (request, response, next) => {
    const identity = identify(request);
    const result = await requestRateLimiter.consume(`${scope}:${identity}`, options);
    response.set("RateLimit-Limit", String(result.limit));
    response.set("RateLimit-Remaining", String(result.remaining));
    response.set("RateLimit-Reset", result.resetAt);
    if (!result.allowed) {
      response.set("Retry-After", String(result.retryAfterSeconds));
      return response.status(429).json({
        error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        code: "RATE_LIMITED",
        retryAfterSeconds: result.retryAfterSeconds
      });
    }
    next();
  };
}

const loginRateLimit = rateLimit("login", { limit: 10, windowMs: 15 * 60_000 }, (request) =>
  `${request.ip}:${String(request.body?.email || "").trim().toLocaleLowerCase()}`);
const signupRateLimit = rateLimit("signup", { limit: 5, windowMs: 60 * 60_000 }, (request) => request.ip);
const verificationRateLimit = rateLimit("email-verification", { limit: 10, windowMs: 15 * 60_000 }, (request) =>
  `${request.ip}:${String(request.body?.email || "").trim().toLocaleLowerCase()}`);
const verificationResendRateLimit = rateLimit("email-verification-resend", { limit: 3, windowMs: 15 * 60_000 }, (request) =>
  `${request.ip}:${String(request.body?.email || "").trim().toLocaleLowerCase()}`);
const meetingAnalysisRateLimit = rateLimit("meeting-analysis", { limit: 12, windowMs: 60 * 60_000 }, (request) =>
  `${request.auth?.organization?.id || "none"}:${request.auth?.user?.id || request.ip}`);
const speakerEnrollmentRateLimit = rateLimit("speaker-enrollment", { limit: 12, windowMs: 60 * 60_000 }, (request) =>
  `${request.auth?.organization?.id || "none"}:${request.auth?.user?.id || request.ip}`);
const speakerIdentificationRateLimit = rateLimit("speaker-identification", { limit: 30, windowMs: 60 * 60_000 }, (request) =>
  `${request.auth?.organization?.id || "none"}:${request.auth?.user?.id || request.ip}`);
const knowledgeEvidenceRateLimit = rateLimit("knowledge-evidence", { limit: 240, windowMs: 60 * 60_000 }, (request) =>
  request.auth?.user?.id || request.ip);
const knowledgeExplanationRateLimit = rateLimit("knowledge-explanation", { limit: 30, windowMs: 60 * 60_000 }, (request) =>
  request.auth?.user?.id || request.ip);
const transcriptionRateLimit = rateLimit("transcription", { limit: 12, windowMs: 60 * 60_000 }, (request) =>
  `${request.auth?.organization?.id || "none"}:${request.auth?.user?.id || request.ip}`);
const transcriptionConcurrencyLimit = createConcurrencyLimit(
  Math.min(4, Number(process.env.TRANSCRIPTION_CONCURRENCY) || 2),
  { code: "TRANSCRIPTION_BUSY", message: "동시에 처리 중인 전사가 많습니다. 잠시 후 다시 시도해 주세요." }
);

app.use((request, response, next) => {
  const startedAt = performance.now();
  request.id = request.headers["x-request-id"] || randomUUID();
  response.set("X-Request-ID", request.id);
  response.set("X-Content-Type-Options", "nosniff");
  response.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.set("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
  response.set("Cross-Origin-Opener-Policy", "same-origin");
  response.set("X-Frame-Options", "DENY");
  if (request.path.startsWith("/api/")) response.set("Cache-Control", "no-store");
  if (process.env.NODE_ENV === "production") {
    response.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    response.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  }
  response.on("finish", () => {
    if (!request.path.startsWith("/api/") && response.statusCode < 400) return;
    console.log(JSON.stringify({
      level: response.statusCode >= 500 ? "error" : "info",
      event: "http_request",
      requestId: request.id,
      method: request.method,
      path: request.path,
      status: response.statusCode,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      userId: request.auth?.user?.id || null,
      organizationId: request.auth?.organization?.id || null
    }));
  });
  next();
});

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function sessionToken(request) {
  return parseCookies(request.headers.cookie)[sessionCookieName] || "";
}

function setSessionCookie(response, token, expiresAt) {
  const sameSite = ["lax", "strict", "none"].includes(process.env.SESSION_COOKIE_SAME_SITE) ? process.env.SESSION_COOKIE_SAME_SITE : "lax";
  response.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite,
    secure: process.env.NODE_ENV === "production",
    expires: new Date(expiresAt),
    path: "/"
  });
}

function clearSessionCookie(response) {
  const sameSite = ["lax", "strict", "none"].includes(process.env.SESSION_COOKIE_SAME_SITE) ? process.env.SESSION_COOKIE_SAME_SITE : "lax";
  response.clearCookie(sessionCookieName, {
    httpOnly: true,
    sameSite,
    secure: process.env.NODE_ENV === "production",
    path: "/"
  });
}

async function optionalAuth(request, _response, next) {
  request.auth = await authStore.getContextBySession(sessionToken(request));
  next();
}

async function requireAuth(request, response, next) {
  request.auth = await authStore.getContextBySession(sessionToken(request));
  if (!request.auth) return response.status(401).json({ error: "로그인이 필요합니다.", code: "UNAUTHENTICATED" });
  next();
}

function requireOrganization(request, response, next) {
  if (!request.auth?.organization) {
    return response.status(409).json({ error: "먼저 조직을 만들거나 가입해 주세요.", code: "ORGANIZATION_REQUIRED" });
  }
  next();
}

function configuredServices() {
  return {
    openai: Boolean(process.env.OPENAI_API_KEY),
    deepgram: Boolean(process.env.DEEPGRAM_API_KEY),
    biometricEncryption: Boolean(process.env.VOICE_BIOMETRIC_KEY),
    email: emailService.mode,
    meetingIntelligence: meetingIntelligenceService.mode,
    knowledgeExplanation: knowledgeExplanationService.mode,
    database: databaseMode,
    speakerStorage: speakerStorageMode,
    speakerModel: speakerModelInfo.id,
    speakerInference: speakerInferenceInfo,
    speakerModelState,
    knowledgeTwin: "evidence-v1"
  };
}

function publicSpeakerProfile(speaker) {
  if (!speaker) return null;
  const {
    profile: _profile,
    profiles: _profiles,
    referenceAudio: _referenceAudio,
    enrollmentFingerprints: _enrollmentFingerprints,
    verificationFingerprints: _verificationFingerprints,
    storage: _storage,
    encryption: _encryption,
    ...publicProfile
  } = speaker;
  return publicProfile;
}

async function personalizedTermsFor(user, terms) {
  const knownTerms = user.vocabulary?.knownTerms || [];
  const states = await knowledgeStore.statesForTerms(user.id, terms.map(({ term }) => term), knownTerms);
  return personalizeKnowledgeTerms(terms, states, user.vocabulary?.roles || []);
}

async function personalizedIntelligenceFor(user, intelligence) {
  if (!intelligence) return null;
  return { ...intelligence, terms: await personalizedTermsFor(user, intelligence.terms || []) };
}

function publicKnowledgeExplanation(stored) {
  const explanation = {
    cacheKey: stored.cacheKey,
    conceptId: stored.conceptId,
    term: stored.term,
    level: stored.level,
    explanation: stored.result.explanation,
    analogy: stored.result.analogy,
    checkQuestion: stored.result.checkQuestion,
    choices: stored.result.choices,
    source: stored.source,
    model: stored.model,
    meetingId: stored.meetingId,
    segmentIndex: stored.segmentIndex,
    generatedAt: stored.createdAt
  };
  if (stored.answeredChoiceIndex != null) {
    explanation.answer = {
      choiceIndex: stored.answeredChoiceIndex,
      correct: stored.answeredChoiceIndex === Number(stored.result.correctChoiceIndex),
      rationale: stored.result.answerRationale,
      answeredAt: stored.answeredAt
    };
  }
  return explanation;
}

function pcmToWave(pcm, sampleRate = 16_000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function decodeToPcm(input, maximumSeconds = 30) {
  return new Promise((resolve, reject) => {
    const argumentsList = [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn",
      "-ac", "1", "-ar", "16000"
    ];
    if (Number.isFinite(maximumSeconds) && maximumSeconds > 0) argumentsList.push("-t", String(maximumSeconds));
    argumentsList.push("-f", "s16le", "pipe:1");
    const ffmpeg = spawn("ffmpeg", argumentsList);
    const output = [];
    let errorText = "";

    ffmpeg.stdout.on("data", (chunk) => output.push(chunk));
    ffmpeg.stderr.on("data", (chunk) => { errorText += chunk.toString(); });
    ffmpeg.on("error", (error) => reject(new Error(`ffmpeg를 실행할 수 없습니다: ${error.message}`)));
    ffmpeg.on("close", (code) => {
      if (code !== 0) return reject(new Error(errorText.trim() || "음성 파일을 변환하지 못했습니다."));
      resolve(Buffer.concat(output));
    });
    ffmpeg.stdin.end(input);
  });
}

async function transcribeAudioFile(file, language, organizationId) {
  const form = new FormData();
  form.append("file", new Blob([file.buffer], { type: file.mimetype }), normalizeUploadFilename(file.originalname, "recording.webm"));
  form.append("model", "gpt-4o-transcribe-diarize");
  form.append("response_format", "diarized_json");
  form.append("chunking_strategy", "auto");
  if (language) form.append("language", language);

  const allKnownSpeakers = await speakerStore.loadProfiles(organizationId);
  const knownSpeakers = allKnownSpeakers.slice(0, 4);
  if (knownSpeakers.length) {
    form.append("known_speaker_names", JSON.stringify(knownSpeakers.map(({ name }) => name)));
    form.append("known_speaker_references", JSON.stringify(knownSpeakers.map(({ referenceAudio }) =>
      `data:audio/wav;base64,${referenceAudio.toString("base64")}`)));
  }

  const openAIResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(120_000)
  });
  const payload = await openAIResponse.json().catch(() => null);
  if (!openAIResponse.ok) {
    const error = new Error(payload?.error?.message || "음성을 전사하지 못했습니다.");
    error.status = openAIResponse.status;
    throw error;
  }
  const normalized = normalizeTranscript(payload, { knownSpeakers: knownSpeakers.map(({ name }) => name) });
  if (!allKnownSpeakers.length) return normalized;
  try {
    const decoded = await decodeToPcm(file.buffer, 1_800);
    const originalPcm = new Int16Array(decoded.buffer, decoded.byteOffset, Math.floor(decoded.byteLength / 2));
    const model = await getSpeakerEmbeddingModel(speakerModelCache, speakerModelPath);
    return await reconcileTranscriptSpeakers(normalized, originalPcm, allKnownSpeakers, model, {
      threshold: Number(process.env.SPEAKER_MATCH_THRESHOLD) || 0.72,
      margin: Number(process.env.SPEAKER_MATCH_MARGIN) || 0.04
    });
  } catch (speakerError) {
    console.error("Final speaker reconciliation failed:", speakerError);
    return normalized;
  }
}

function transcriptionErrorResponse(error, response) {
  if (error?.name === "TimeoutError") return response.status(504).json({ error: "전사 시간이 초과되었습니다." });
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) {
    return response.status(error.status).json({ error: error.message });
  }
  console.error("Transcription failed:", error);
  return response.status(500).json({ error: "전사 중 서버 오류가 발생했습니다." });
}

async function enrollProfile(pcm) {
  const model = await prepareSpeakerModel();
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const profile = await model.createProfile(samples);
  const vectors = [profile.centroid, ...profile.exemplars];
  return {
    buffer: Buffer.concat(vectors.map((vector) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength))),
    vectors,
    count: vectors.length,
    consistency: profile.consistency,
    matchThreshold: profile.matchThreshold
  };
}

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use("/api", (request, response, next) => {
  const origin = request.headers.origin;
  if (origin && hasTrustedOrigin(request)) {
    response.set("Access-Control-Allow-Origin", origin);
    response.set("Access-Control-Allow-Credentials", "true");
    response.set("Vary", "Origin");
  }
  if (request.method !== "OPTIONS") return next();
  if (!origin || !hasTrustedOrigin(request)) return response.status(403).end();
  response.set("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  response.set("Access-Control-Allow-Headers", "Content-Type,X-CSRF-Token,X-Request-ID");
  response.set("Access-Control-Max-Age", "600");
  return response.status(204).end();
});

app.post("/api/auth/signup", requireTrustedOrigin, signupRateLimit, async (request, response) => {
  const user = await authStore.signup(request.body || {});
  const verification = await authStore.issueEmailVerification(user.id);
  const delivery = await emailService.sendVerification({
    email: user.email,
    name: user.name,
    code: verification.code,
    expiresAt: verification.expiresAt,
    idempotencyKey: `email-verification-${user.id}-${verification.expiresAt}`
  });
  response.status(202).json({
    verificationRequired: true,
    email: user.email,
    expiresAt: verification.expiresAt,
    delivery: delivery.provider,
    ...(delivery.developmentCode ? { developmentCode: delivery.developmentCode } : {})
  });
});

app.post("/api/auth/verify-email", requireTrustedOrigin, verificationRateLimit, async (request, response) => {
  const user = await authStore.verifyEmail(request.body?.email, request.body?.code);
  const session = await authStore.createSession(user.id);
  setSessionCookie(response, session.token, session.expiresAt);
  response.json(await authStore.getContextBySession(session.token));
});

app.post("/api/auth/verification/resend", requireTrustedOrigin, verificationResendRateLimit, async (request, response) => {
  const verification = await authStore.resendEmailVerification(request.body?.email, request.body?.password);
  const delivery = await emailService.sendVerification({
    email: verification.user.email,
    name: verification.user.name,
    code: verification.code,
    expiresAt: verification.expiresAt,
    idempotencyKey: `email-verification-${verification.user.id}-${verification.expiresAt}`
  });
  response.json({
    verificationRequired: true,
    email: verification.user.email,
    expiresAt: verification.expiresAt,
    delivery: delivery.provider,
    ...(delivery.developmentCode ? { developmentCode: delivery.developmentCode } : {})
  });
});

app.post("/api/auth/login", requireTrustedOrigin, loginRateLimit, async (request, response) => {
  const user = await authStore.authenticate(request.body?.email, request.body?.password);
  const session = await authStore.createSession(user.id);
  setSessionCookie(response, session.token, session.expiresAt);
  response.json(await authStore.getContextBySession(session.token));
});

app.post("/api/auth/logout", requireTrustedOrigin, requireAuth, requireCsrf, async (request, response) => {
  await authStore.deleteSession(sessionToken(request));
  clearSessionCookie(response);
  response.status(204).end();
});

app.get("/api/session", optionalAuth, async (request, response) => {
  if (!request.auth) return response.json({ authenticated: false });
  response.json({ authenticated: true, ...request.auth });
});

app.get("/api/organizations/suggestion", requireAuth, async (request, response) => {
  response.json({ suggestion: await authStore.organizationSuggestion(request.auth.user.id) });
});

app.post("/api/organizations", requireTrustedOrigin, requireAuth, requireCsrf, async (request, response) => {
  response.status(201).json(await authStore.createOrganization(request.auth.user.id, request.body || {}));
});

app.post("/api/organizations/join", requireTrustedOrigin, requireAuth, requireCsrf, async (request, response) => {
  response.json(await authStore.joinOrganization(request.auth.user.id, request.body?.inviteCode));
});

app.get("/api/organizations/current/members", requireAuth, requireOrganization, async (request, response) => {
  const members = await authStore.listMembers(request.auth.user.id, request.auth.organization.id);
  response.json({ organization: request.auth.organization, members });
});

app.put("/api/profile/vocabulary", requireTrustedOrigin, requireAuth, requireCsrf, async (request, response) => {
  response.json(await authStore.updateVocabulary(request.auth.user.id, request.body || {}));
});

app.get("/api/vocabulary/terms", requireAuth, requireOrganization, async (request, response) => {
  const terms = await meetingStore.listVocabularyTerms(
    request.auth.organization.id,
    request.auth.user.vocabulary?.knownTerms || []
  );
  const privateConcepts = await knowledgeStore.list(request.auth.user.id);
  const existing = new Set(terms.map(({ term }) => normalizeConceptLabel(term).toLocaleLowerCase("ko-KR")));
  for (const concept of privateConcepts) {
    const key = normalizeConceptLabel(concept.term).toLocaleLowerCase("ko-KR");
    if (!existing.has(key)) {
      terms.push({
        term: concept.term, definition: "", explanation: "", personalizedExplanation: "",
        occurrences: 0, meetingCount: 0, firstSeenAt: null, lastSeenAt: null, speakers: []
      });
      existing.add(key);
    }
  }
  response.json({ terms: await personalizedTermsFor(request.auth.user, terms) });
});

app.get("/api/knowledge", requireAuth, async (request, response) => {
  const stored = await knowledgeStore.list(request.auth.user.id);
  const priors = await knowledgeStore.statesForTerms(
    request.auth.user.id,
    request.auth.user.vocabulary?.knownTerms || [],
    request.auth.user.vocabulary?.knownTerms || []
  );
  const concepts = new Map([...priors, ...stored].map((state) => [state.conceptId, state]));
  response.json({ concepts: [...concepts.values()] });
});

app.post("/api/knowledge/evidence", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  knowledgeEvidenceRateLimit, async (request, response) => {
    const allowedClientKinds = new Set([
      "mark_known", "mark_unknown", "request_simpler", "card_open"
    ]);
    const kind = String(request.body?.kind || "");
    if (!allowedClientKinds.has(kind)) return response.status(400).json({ error: "지원하지 않는 지식 피드백입니다." });
    const term = normalizeConceptLabel(request.body?.term);
    if (!term) return response.status(400).json({ error: "피드백할 용어가 필요합니다." });
    const eventId = String(request.body?.eventId || "").trim();
    if (!eventId || eventId.length > 120) return response.status(400).json({ error: "유효한 eventId가 필요합니다." });
    const meetingId = request.body?.meetingId ? String(request.body.meetingId) : null;
    let segmentIndex = request.body?.segmentIndex == null ? null : Number(request.body.segmentIndex);
    if (meetingId) {
      const meeting = await meetingStore.get(meetingId, request.auth.organization.id);
      if (!meeting) return response.status(404).json({ error: "지식 피드백의 회의를 찾지 못했습니다." });
      if (segmentIndex != null && (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= meeting.segments.length)) {
        return response.status(400).json({ error: "지식 피드백의 발화 위치가 올바르지 않습니다." });
      }
    } else {
      segmentIndex = null;
    }
    const known = new Set((request.auth.user.vocabulary?.knownTerms || [])
      .map(normalizeConceptLabel).map((value) => value.toLocaleLowerCase("ko-KR")));
    const result = await knowledgeStore.recordEvidence({
      userId: request.auth.user.id,
      conceptLabel: term,
      kind,
      eventId,
      organizationId: request.auth.organization.id,
      meetingId,
      segmentIndex,
      prior: known.has(term.toLocaleLowerCase("ko-KR")) ? knowledgeTwinDefaults.knownPrior : knowledgeTwinDefaults.prior
    });
    response.status(result.duplicate ? 200 : 201).json(result);
  });

app.post("/api/knowledge/explanations", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  knowledgeExplanationRateLimit, async (request, response) => {
    const meetingId = String(request.body?.meetingId || "").trim();
    const requestedTerm = normalizeConceptLabel(request.body?.term);
    const level = ["simple", "standard", "deep"].includes(request.body?.level) ? request.body.level : "simple";
    if (!meetingId || !requestedTerm) return response.status(400).json({ error: "회의와 용어가 필요합니다." });
    const meeting = await meetingStore.get(meetingId, request.auth.organization.id);
    if (!meeting) return response.status(404).json({ error: "맞춤 해설의 회의를 찾지 못했습니다." });
    const hash = transcriptHash(meeting.segments);
    const intelligence = await meetingStore.getIntelligence(meeting.id, request.auth.organization.id, hash);
    if (!intelligence) return response.status(409).json({ error: "먼저 회의 구조 분석을 완료해 주세요." });
    const requestedKey = requestedTerm.toLocaleLowerCase("ko-KR");
    const analyzedTerm = (intelligence.terms || []).find(({ term }) =>
      normalizeConceptLabel(term).toLocaleLowerCase("ko-KR") === requestedKey);
    const definition = String(analyzedTerm?.definition || analyzedTerm?.explanation || "").trim();
    if (!analyzedTerm || !definition) {
      return response.status(404).json({ error: "검증된 회의 용어 정의를 찾지 못했습니다." });
    }
    const fallbackIndex = Number(analyzedTerm.evidenceSegmentIndex);
    const requestedIndex = request.body?.segmentIndex == null ? fallbackIndex : Number(request.body.segmentIndex);
    const segmentIndex = Number.isInteger(requestedIndex) && requestedIndex >= 0 && requestedIndex < meeting.segments.length
      ? requestedIndex : null;
    const context = segmentIndex == null ? "" : String(meeting.segments[segmentIndex]?.text || "").trim();
    const roles = request.auth.user.vocabulary?.roles || [];
    const cacheKey = knowledgeExplanationCacheKey({
      term: analyzedTerm.term,
      definition,
      context,
      roles,
      level,
      model: `${knowledgeExplanationService.mode}:${knowledgeExplanationService.model}`
    });
    const cached = await knowledgeStore.getExplanation(request.auth.user.id, cacheKey);
    if (cached) return response.json({ explanation: publicKnowledgeExplanation(cached), cached: true });
    try {
      const result = await knowledgeExplanationService.generate({
        userId: request.auth.user.id,
        term: analyzedTerm.term,
        definition,
        context,
        roles,
        level
      });
      const stored = await knowledgeStore.saveExplanation({
        userId: request.auth.user.id,
        cacheKey,
        conceptLabel: analyzedTerm.term,
        level,
        result,
        source: result.source,
        model: result.model,
        meetingId: meeting.id,
        segmentIndex
      });
      return response.status(201).json({ explanation: publicKnowledgeExplanation(stored), cached: false });
    } catch (error) {
      console.error("Knowledge explanation failed:", error);
      return response.status(error?.name === "AbortError" ? 504 : 502).json({
        error: error?.name === "AbortError"
          ? "맞춤 해설 생성 시간이 초과되었습니다."
          : "맞춤 해설을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요."
      });
    }
  });

app.post("/api/knowledge/explanations/:cacheKey/answer", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  knowledgeEvidenceRateLimit, async (request, response) => {
    const cacheKey = String(request.params.cacheKey || "");
    const choiceIndex = Number(request.body?.choiceIndex);
    if (!/^[a-f0-9]{64}$/.test(cacheKey)) return response.status(400).json({ error: "유효한 확인 질문 ID가 필요합니다." });
    if (!Number.isInteger(choiceIndex) || choiceIndex < 0 || choiceIndex > 2) {
      return response.status(400).json({ error: "답변 선택이 올바르지 않습니다." });
    }
    let stored = await knowledgeStore.getExplanation(request.auth.user.id, cacheKey);
    if (!stored) return response.status(404).json({ error: "확인 질문을 찾지 못했습니다." });
    const meeting = stored.meetingId
      ? await meetingStore.get(stored.meetingId, request.auth.organization.id)
      : null;
    if (!meeting) return response.status(404).json({ error: "확인 질문의 회의를 찾지 못했습니다." });
    const claimed = await knowledgeStore.claimExplanationAnswer(request.auth.user.id, cacheKey, choiceIndex);
    if (!claimed) stored = await knowledgeStore.getExplanation(request.auth.user.id, cacheKey);
    const recordedChoice = claimed ? choiceIndex : stored.answeredChoiceIndex;
    const correct = recordedChoice === Number(stored.result.correctChoiceIndex);
    if (!claimed) {
      return response.json({
        correct,
        choiceIndex: recordedChoice,
        rationale: stored.result.answerRationale,
        state: (await knowledgeStore.statesForTerms(request.auth.user.id, [stored.term],
          request.auth.user.vocabulary?.knownTerms || [])).at(0),
        duplicate: true
      });
    }
    const known = new Set((request.auth.user.vocabulary?.knownTerms || [])
      .map(normalizeConceptLabel).map((value) => value.toLocaleLowerCase("ko-KR")));
    const result = await knowledgeStore.recordEvidence({
      userId: request.auth.user.id,
      conceptLabel: stored.term,
      kind: correct ? "correct_answer" : "incorrect_answer",
      eventId: `quiz:${cacheKey}`,
      organizationId: request.auth.organization.id,
      meetingId: meeting.id,
      segmentIndex: stored.segmentIndex,
      prior: known.has(stored.term.toLocaleLowerCase("ko-KR"))
        ? knowledgeTwinDefaults.knownPrior : knowledgeTwinDefaults.prior
    });
    response.status(result.duplicate ? 200 : 201).json({
      correct,
      choiceIndex: recordedChoice,
      rationale: stored.result.answerRationale,
      state: result.state,
      duplicate: result.duplicate
    });
  });

app.delete("/api/knowledge/:conceptId", requireTrustedOrigin, requireAuth, requireCsrf, async (request, response) => {
  if (!/^concept_[a-f0-9]{32}$/.test(request.params.conceptId)) {
    return response.status(400).json({ error: "유효한 개념 ID가 필요합니다." });
  }
  await knowledgeStore.remove(request.auth.user.id, request.params.conceptId);
  response.status(204).end();
});

app.get("/api/health", optionalAuth, async (request, response) => {
  const speakers = request.auth?.organization ? await speakerStore.list(request.auth.organization.id) : [];
  response.json({ ok: true, services: configuredServices(), speakerCount: speakers.length });
});

app.get("/api/health/live", (_request, response) => {
  response.json({ ok: true, status: "live" });
});

app.get("/api/health/ready", async (_request, response) => {
  try {
    if (postgresDatabase) await postgresDatabase.healthCheck();
    else (await openSqliteDatabase(databasePath)).prepare("SELECT 1").get();
    const deepgramConfigured = Boolean(process.env.DEEPGRAM_API_KEY);
    const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
    const emailConfigured = emailService.mode === "resend" || process.env.NODE_ENV !== "production";
    const biometricEncryptionConfigured = Boolean(process.env.VOICE_BIOMETRIC_KEY);
    const speakerModelReady = !shouldPreloadSpeakerModel || speakerModelState === "ready";
    const speakerStorageReady = speakerStorageMode !== "vercel-blob" || Boolean(process.env.BLOB_READ_WRITE_TOKEN);
    const readiness = serviceReadiness({
      environment: process.env.NODE_ENV,
      deepgram: deepgramConfigured,
      openai: openaiConfigured,
      email: emailConfigured,
      biometricEncryption: biometricEncryptionConfigured,
      speakerModel: speakerModelReady,
      speakerStorage: speakerStorageReady
    });
    response.status(readiness.ready ? 200 : 503).json({
      ok: readiness.ready,
      status: readiness.ready ? "ready" : "degraded",
      database: `${databaseMode}:ready`,
      deepgram: deepgramConfigured ? "configured" : "missing",
      openai: openaiConfigured ? "configured" : "missing",
      email: emailConfigured ? emailService.mode : "missing",
      biometricEncryption: biometricEncryptionConfigured ? "configured" : "missing",
      speakerStorage: speakerStorageReady ? speakerStorageMode : "missing",
      speakerModel: speakerModelState,
      missing: readiness.missing,
      ...(speakerModelFailure ? { speakerModelError: "모델을 준비하지 못했습니다." } : {})
    });
  } catch (error) {
    response.status(503).json({ ok: false, status: "unavailable", database: "unavailable" });
  }
});

app.get("/api/speakers", requireAuth, requireOrganization, async (request, response) => {
  response.json({ speakers: (await speakerStore.list(request.auth.organization.id)).map(publicSpeakerProfile) });
});

app.get("/api/meetings", requireAuth, requireOrganization, async (request, response) => {
  response.json({ meetings: await meetingStore.list(request.auth.organization.id) });
});

app.get("/api/meetings/:id", requireAuth, requireOrganization, async (request, response) => {
  const meeting = await meetingStore.get(request.params.id, request.auth.organization.id);
  if (!meeting) return response.status(404).json({ error: "회의 문서를 찾지 못했습니다." });
  response.json({ meeting });
});

app.post("/api/meetings", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  const meeting = await meetingStore.create({
    organizationId: request.auth.organization.id,
    createdBy: request.auth.user.id,
    language: request.body?.language,
    source: request.body?.source,
    mode: request.body?.mode,
    title: request.body?.title
  });
  response.status(201).json({ meeting });
});

app.post("/api/meetings/import", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  transcriptionRateLimit, transcriptionConcurrencyLimit, upload.single("audio"), async (request, response) => {
    if (!request.file) return response.status(400).json({ error: "지원되는 오디오 파일이 필요합니다." });
    try {
      const language = typeof request.body?.language === "string" ? request.body.language.trim() : "";
      const importKey = typeof request.body?.importId === "string" ? request.body.importId.trim() : "";
      if (!/^[a-f0-9-]{36}$/i.test(importKey)) return response.status(400).json({ error: "유효한 업로드 ID가 필요합니다." });
      const existing = await meetingStore.getByImportKey(request.auth.organization.id, importKey);
      if (existing) return response.json({ meeting: existing, duplicate: true });
      if (!process.env.OPENAI_API_KEY) return response.status(503).json({ error: "OPENAI_API_KEY가 설정되지 않았습니다." });
      const transcription = await transcribeAudioFile(request.file, language, request.auth.organization.id);
      if (!transcription.segments?.length) return response.status(422).json({ error: "인식된 대화가 없습니다." });
      const meeting = await meetingStore.createCompleted({
        organizationId: request.auth.organization.id,
        createdBy: request.auth.user.id,
        language,
        source: "upload",
        mode: "speaker",
        title: uploadTitle(request.file.originalname),
        segments: transcription.segments,
        duration: transcription.duration,
        importKey
      });
      return response.status(201).json({ meeting });
    } catch (error) {
      return transcriptionErrorResponse(error, response);
    }
  });

app.patch("/api/meetings/:id", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  const meeting = await meetingStore.update(request.params.id, request.auth.organization.id, request.body || {});
  if (!meeting) return response.status(404).json({ error: "회의 문서를 찾지 못했습니다." });
  response.json({ meeting });
});

app.delete("/api/meetings/:id", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  if (!/^[a-f0-9-]{36}$/i.test(request.params.id)) return response.status(400).json({ error: "잘못된 회의 ID입니다." });
  const removed = await meetingStore.remove(request.params.id, request.auth.organization.id);
  if (!removed) return response.status(404).json({ error: "회의 문서를 찾지 못했습니다." });
  response.status(204).end();
});

app.get("/api/meetings/:id/intelligence", requireAuth, requireOrganization, async (request, response) => {
  const meeting = await meetingStore.get(request.params.id, request.auth.organization.id);
  if (!meeting) return response.status(404).json({ error: "회의 문서를 찾지 못했습니다." });
  const hash = transcriptHash(meeting.segments);
  const intelligence = await meetingStore.getIntelligence(meeting.id, request.auth.organization.id, hash);
  response.json({ intelligence: await personalizedIntelligenceFor(request.auth.user, intelligence) });
});

app.post("/api/meetings/:id/intelligence", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  meetingAnalysisRateLimit, async (request, response) => {
    const meeting = await meetingStore.get(request.params.id, request.auth.organization.id);
    if (!meeting) return response.status(404).json({ error: "회의 문서를 찾지 못했습니다." });
    if (!meeting.segments.length) return response.status(409).json({ error: "분석할 실제 발화가 없습니다." });
    const hash = transcriptHash(meeting.segments);
    if (!request.body?.force) {
      const cached = await meetingStore.getIntelligence(meeting.id, request.auth.organization.id, hash);
      if (cached) return response.json({ intelligence: await personalizedIntelligenceFor(request.auth.user, cached), cached: true });
    }
    try {
      const result = await meetingIntelligenceService.analyze(meeting);
      const intelligence = await meetingStore.saveIntelligence({
        meetingId: meeting.id,
        organizationId: request.auth.organization.id,
        transcriptHash: hash,
        source: result.source,
        model: result.model,
        result
      });
      return response.json({ intelligence: await personalizedIntelligenceFor(request.auth.user, intelligence), cached: false });
    } catch (error) {
      console.error("Meeting intelligence failed:", error);
      return response.status(error?.name === "AbortError" ? 504 : 502).json({
        error: error?.name === "AbortError" ? "회의 분석 시간이 초과되었습니다." : "회의 구조 분석을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요."
      });
    }
  });

app.post("/api/speakers", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, speakerEnrollmentRateLimit, upload.single("voice"), async (request, response) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
  if (!name || name.length > 40) return response.status(400).json({ error: "이름은 1~40자로 입력해 주세요." });
  if (!request.file) return response.status(400).json({ error: "MP3 또는 WAV 등록 음성이 필요합니다." });

  try {
    const existing = await speakerStore.loadProfiles(request.auth.organization.id);
    if (existing.some((speaker) => speaker.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      return response.status(409).json({ error: "이미 등록된 이름입니다." });
    }

    const pcm = await decodeToPcm(request.file.buffer);
    const duration = pcm.length / 2 / 16_000;
    if (duration < 5) return response.status(400).json({ error: "등록 음성은 한 사람의 말소리가 포함된 5초 이상이어야 합니다." });
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    const quality = analyzePcmQuality(samples);
    if (!quality.usable) {
      return response.status(422).json({
        error: quality.warnings[0] || "등록 음성 품질이 충분하지 않습니다.",
        quality
      });
    }
    const profile = await enrollProfile(pcm);
    const separation = assessNewSpeakerSeparation(profile.vectors, existing);
    if (!separation.accepted) {
      return response.status(422).json({ error: separation.reason, comparison: separation });
    }
    const enrolledAt = new Date().toISOString();
    const speaker = {
      id: randomUUID(), name, duration, model: speakerModelInfo.id,
      profileCount: profile.count,
      profileDimensions: speakerModelInfo.dimensions,
      enrollmentConsistency: profile.consistency,
      matchThreshold: profile.matchThreshold,
      audioQuality: quality,
      enrollmentSessionCount: 1,
      totalEnrollmentDuration: duration,
      lastEnrolledAt: enrolledAt,
      enrollmentSessions: [{ duration, qualityScore: quality.score, enrolledAt }],
      enrollmentFingerprints: [speakerProbeFingerprint(samples)],
      organizationId: request.auth.organization.id,
      createdBy: request.auth.user.id,
      createdAt: new Date().toISOString()
    };
    const storedSpeaker = await speakerStore.save(speaker, profile.buffer, pcmToWave(pcm));
    return response.status(201).json({ speaker: publicSpeakerProfile(storedSpeaker) });
  } catch (error) {
    console.error("Speaker enrollment failed:", error);
    return response.status(422).json({ error: error.message || "목소리를 등록하지 못했습니다." });
  }
});

app.post("/api/speakers/identify", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  speakerIdentificationRateLimit, upload.single("voice"), async (request, response) => {
    if (!request.file) return response.status(400).json({ error: "식별할 MP3 또는 WAV 음성이 필요합니다." });
    try {
      const speakers = await speakerStore.loadProfiles(request.auth.organization.id);
      if (!speakers.length) return response.status(409).json({ error: "먼저 한 명 이상의 목소리를 등록해 주세요." });
      const pcm = await decodeToPcm(request.file.buffer, 15);
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
      const quality = analyzePcmQuality(samples, speakerModelInfo.sampleRate);
      if (!isSpeakerInferenceQuality(quality)) {
        return response.status(422).json({
          error: quality.warnings[0] || "식별할 수 있는 말소리가 충분하지 않습니다.",
          quality
        });
      }
      const model = await prepareSpeakerModel();
      const scores = await model.compare(samples, speakers.map(({ profiles }) => profiles), { maximumEmbeddings: 3 });
      if (!scores) return response.status(422).json({ error: "식별할 수 있는 말소리가 충분하지 않습니다.", quality });
      const decision = speakerDecision(scores, speakers, {
        threshold: Number(process.env.SPEAKER_MATCH_THRESHOLD) || 0.72,
        margin: Number(process.env.SPEAKER_MATCH_MARGIN) || 0.04
      });
      const reasonMessages = {
        accepted: `${decision.identity?.name || "등록 화자"}님의 목소리로 판정했습니다.`,
        below_threshold: "등록된 어떤 목소리와도 충분히 가깝지 않아 미등록 화자로 판정했습니다.",
        ambiguous: "둘 이상의 등록 목소리와 비슷해 안전하게 이름을 확정하지 않았습니다.",
        invalid_scores: "화자 비교 결과를 계산하지 못했습니다."
      };
      const expectedSpeakerId = String(request.body?.expectedSpeakerId || "").trim();
      const expectedSpeaker = expectedSpeakerId ? speakers.find(({ id }) => id === expectedSpeakerId) : null;
      if (expectedSpeakerId && !expectedSpeaker) return response.status(400).json({ error: "검증 대상 화자를 찾지 못했습니다." });
      const enrollmentAudioThreshold = Number(process.env.SPEAKER_DUPLICATE_AUDIO_THRESHOLD) || 0.985;
      let enrollmentAudioSimilarity = null;
      if (request.body?.independentRecording === "true" && expectedSpeaker?.referenceAudio) {
        try {
          const referencePcm = await decodeToPcm(expectedSpeaker.referenceAudio);
          const referenceSamples = new Int16Array(
            referencePcm.buffer,
            referencePcm.byteOffset,
            Math.floor(referencePcm.byteLength / 2)
          );
          enrollmentAudioSimilarity = recordingEnvelopeSimilarity(samples, referenceSamples);
        } catch (error) {
          console.error("Enrollment audio similarity check failed:", error);
        }
      }
      const verification = speakerVerificationUpdate(expectedSpeaker, {
        fingerprint: speakerProbeFingerprint(samples),
        score: decision.bestScore,
        qualityScore: quality.score,
        independentRecording: request.body?.independentRecording === "true",
        expectedSpeakerId,
        predictedSpeakerId: decision.identity?.id || "",
        enrollmentAudioSimilarity,
        enrollmentAudioThreshold
      });
      let speakerProfile = null;
      if (verification.changes) {
        speakerProfile = publicSpeakerProfile(await speakerStore.updateMetadata(
          expectedSpeaker.id,
          request.auth.organization.id,
          verification.changes
        ));
      }
      const verificationMessages = {
        independent_probe: "등록과 다른 음성으로 실사용 검증을 기록했습니다.",
        not_confirmed: "식별 결과만 확인했습니다. 별도 녹음 확인을 선택하지 않아 검증 횟수에는 반영하지 않았습니다.",
        expected_not_selected: "실제 화자를 선택하지 않아 검증 횟수에는 반영하지 않았습니다.",
        expected_not_matched: "선택한 실제 화자를 모델이 확정하지 못한 실패 시도를 기록했습니다. 다른 환경의 샘플을 추가해 주세요.",
        unexpected_identity: "모델 판정과 선택한 실제 화자가 달랐던 실패 시도를 기록했습니다. 프로필 구분도를 점검해 주세요.",
        enrollment_audio: "등록 음성과 동일하거나 재인코딩한 파일이라 별도 환경 검증에는 반영하지 않았습니다.",
        duplicate_probe: "이미 검증한 동일 음성이라 검증 횟수를 늘리지 않았습니다.",
        needs_new_enrollment: "기존 프로필에는 등록 파일 지문이 없어 새 샘플을 추가한 뒤 별도 음성으로 다시 검증해 주세요.",
        not_matched: "이름이 확정되지 않아 검증 기록을 변경하지 않았습니다."
      };
      return response.json({
        identification: {
          matched: decision.accepted,
          speaker: decision.identity ? { id: decision.identity.id, name: decision.identity.name } : null,
          confidence: decision.bestScore,
          scoreGap: decision.scoreGap,
          requiredThreshold: decision.requiredThreshold,
          requiredMargin: decision.requiredMargin,
          reason: decision.reason,
          message: reasonMessages[decision.reason]
        },
        quality,
        verification: {
          recorded: verification.recorded,
          attemptRecorded: verification.attemptRecorded,
          reason: verification.reason,
          message: verificationMessages[verification.reason],
          ...(enrollmentAudioSimilarity == null ? {} : {
            enrollmentAudioSimilarity,
            enrollmentAudioThreshold
          })
        },
        speakerProfile
      });
    } catch (error) {
      console.error("Speaker identification probe failed:", error);
      return response.status(422).json({ error: error.message || "테스트 음성을 식별하지 못했습니다." });
    }
  });

app.post("/api/speakers/:id/samples", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, speakerEnrollmentRateLimit, upload.single("voice"), async (request, response) => {
  if (!/^[a-f0-9-]{36}$/i.test(request.params.id)) return response.status(400).json({ error: "잘못된 화자 ID입니다." });
  if (!request.file) return response.status(400).json({ error: "MP3 또는 WAV 추가 음성이 필요합니다." });
  try {
    const registeredSpeakers = await speakerStore.loadProfiles(request.auth.organization.id);
    const existing = registeredSpeakers.find(({ id }) => id === request.params.id);
    if (!existing) return response.status(404).json({ error: "등록된 목소리를 찾지 못했습니다." });
    if ((existing.enrollmentSessionCount || 1) >= 8) return response.status(409).json({ error: "한 사람당 최대 8회까지 음성을 추가할 수 있습니다." });
    const pcm = await decodeToPcm(request.file.buffer);
    const duration = pcm.length / 2 / 16_000;
    if (duration < 5) return response.status(400).json({ error: "추가 음성은 한 사람의 말소리가 포함된 5초 이상이어야 합니다." });
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    const quality = analyzePcmQuality(samples);
    if (!quality.usable) return response.status(422).json({ error: quality.warnings[0] || "추가 음성 품질이 충분하지 않습니다.", quality });
    const additional = await enrollProfile(pcm);
    const extension = assessSpeakerProfileExtension(
      existing,
      additional.vectors,
      registeredSpeakers.filter(({ id }) => id !== existing.id)
    );
    if (!extension.accepted) return response.status(422).json({ error: extension.reason, comparison: extension });
    const merged = mergeSpeakerProfileVectors([existing.profiles, additional.vectors], { maximumProfiles: 32 });
    if (merged.consistency < 0.58) return response.status(422).json({ error: "추가 후 목소리 특성의 일관성이 너무 낮아 저장하지 않았습니다." });
    const profileBuffer = Buffer.concat(merged.vectors.map((vector) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)));
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      profileCount: merged.vectors.length,
      enrollmentConsistency: merged.consistency,
      matchThreshold: merged.matchThreshold,
      enrollmentSessionCount: (existing.enrollmentSessionCount || 1) + 1,
      totalEnrollmentDuration: (existing.totalEnrollmentDuration || existing.duration || 0) + duration,
      lastEnrolledAt: now,
      latestAudioQuality: quality,
      latestEnrollmentAffinity: extension.targetAffinity,
      nearestOtherSpeakerAffinity: extension.nearestOther?.affinity ?? null,
      enrollmentSessions: [...(existing.enrollmentSessions || []), { duration, qualityScore: quality.score, enrolledAt: now }].slice(-8),
      enrollmentFingerprints: [...(existing.enrollmentFingerprints || []), speakerProbeFingerprint(samples)].slice(-8)
    };
    delete updated.profile;
    delete updated.profiles;
    delete updated.referenceAudio;
    const referenceAudio = quality.score > (existing.audioQuality?.score || 0) ? pcmToWave(pcm) : existing.referenceAudio;
    const storedSpeaker = await speakerStore.replace(updated, profileBuffer, referenceAudio, request.auth.organization.id);
    return response.json({ speaker: publicSpeakerProfile(storedSpeaker) });
  } catch (error) {
    console.error("Speaker sample enrollment failed:", error);
    return response.status(422).json({ error: error.message || "추가 목소리를 등록하지 못했습니다." });
  }
});

app.delete("/api/speakers/:id", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  if (!/^[a-f0-9-]{36}$/i.test(request.params.id)) return response.status(400).json({ error: "잘못된 화자 ID입니다." });
  const removed = await speakerStore.remove(request.params.id, request.auth.organization.id);
  if (!removed) return response.status(404).json({ error: "등록된 목소리를 찾지 못했습니다." });
  response.status(204).end();
});

app.post("/api/transcribe", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  transcriptionRateLimit, transcriptionConcurrencyLimit, upload.single("audio"), async (request, response) => {
  if (!process.env.OPENAI_API_KEY) return response.status(503).json({ error: "OPENAI_API_KEY가 설정되지 않았습니다." });
  if (!request.file) return response.status(400).json({ error: "지원되는 오디오 파일이 필요합니다." });

  try {
    const language = typeof request.body?.language === "string" ? request.body.language.trim() : "";
    return response.json(await transcribeAudioFile(request.file, language, request.auth.organization.id));
  } catch (error) {
    return transcriptionErrorResponse(error, response);
  }
});

app.use("/api", (_request, response) => {
  response.status(404).json({ error: "API 경로를 찾지 못했습니다." });
});

app.use((error, _request, response, _next) => {
  if (error instanceof AuthError) {
    return response.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(error.remainingAttempts ? { remainingAttempts: error.remainingAttempts } : {})
    });
  }
  if (error instanceof EmailDeliveryError) {
    return response.status(502).json({ error: error.message, code: error.code });
  }
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return response.status(413).json({ error: "오디오 파일은 25MB 이하여야 합니다." });
  }
  console.error("Request failed:", error);
  return response.status(400).json({ error: "요청을 처리할 수 없습니다." });
});

await Promise.all([
  authStore.initialize(), speakerStore.initialize(), meetingStore.initialize(), knowledgeStore.initialize(), requestRateLimiter.initialize()
]);
const server = app.listen(port, () => {
  console.log(`Voice Partition is running at http://localhost:${port}`);
});
if (shouldPreloadSpeakerModel) {
  prepareSpeakerModel()
    .then(() => console.log(JSON.stringify({ level: "info", event: "speaker_model_ready", model: speakerModelInfo.id })))
    .catch((error) => console.error(JSON.stringify({ level: "error", event: "speaker_model_failed", message: error.message })));
}

const liveServer = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  if (requestUrl.pathname !== "/api/live") return;
  if (!hasTrustedOrigin(request)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  liveServer.handleUpgrade(request, socket, head, (websocket) => {
    liveServer.emit("connection", websocket, request, requestUrl);
  });
});

liveServer.on("connection", async (client, request, requestUrl) => {
  if (!process.env.DEEPGRAM_API_KEY) {
    client.send(JSON.stringify({ type: "error", message: "DEEPGRAM_API_KEY가 필요합니다." }));
    return client.close(1011);
  }

  let deepgram;
  let finalizeFallback;
  try {
    const auth = await authStore.getContextBySession(sessionToken(request));
    if (!auth) throw new Error("로그인이 필요합니다.");
    if (!auth.organization) throw new Error("먼저 조직을 만들거나 가입해 주세요.");
    const mode = requestUrl.searchParams.get("mode") === "speaker" ? "speaker" : "stt";
    const speakers = mode === "speaker" ? await speakerStore.loadProfiles(auth.organization.id) : [];
    if (mode === "speaker" && !speakers.length) throw new Error("화자 식별 모드에는 등록 목소리가 한 명 이상 필요합니다.");
    if (mode === "speaker" && speakers.some(({ profiles }) => profiles.some((profile) => profile.length !== speakerModelInfo.dimensions))) {
      throw new Error("이전 방식으로 등록된 목소리가 있습니다. 삭제하고 다시 등록해 주세요.");
    }
    let preparationTimer = null;
    if (mode === "speaker" && speakerModelState !== "ready" && client.readyState === WebSocket.OPEN) {
      const preparationStartedAt = Date.now();
      const sendPreparationProgress = () => {
        if (client.readyState !== WebSocket.OPEN) return;
        const elapsedSeconds = Math.floor((Date.now() - preparationStartedAt) / 1000);
        client.send(JSON.stringify({
          type: "preparing",
          elapsedSeconds,
          message: elapsedSeconds
            ? `화자 인식 모델 준비 중 · ${elapsedSeconds}초 경과`
            : "화자 인식 모델을 준비하고 있습니다. 첫 실행은 최대 2분 정도 걸릴 수 있습니다."
        }));
      };
      sendPreparationProgress();
      preparationTimer = setInterval(sendPreparationProgress, 15_000);
    }
    let speakerModel = null;
    try {
      speakerModel = mode === "speaker" ? await prepareSpeakerModel() : null;
    } finally {
      if (preparationTimer) clearInterval(preparationTimer);
    }
    const profiles = speakers.map(({ profiles: candidates }) => candidates);
    const identityTracker = mode === "speaker" ? new SpeakerIdentityTracker() : null;
    const recognitionFrames = [];
    const analyzedRegions = new Set();
    const pendingSpeakerClusters = new Set();
    const audioHistory = new PcmHistoryBuffer(speakerModelInfo.sampleRate * 90);
    const speakerAudioAccumulator = new SpeakerAudioAccumulator({ sampleRate: speakerModelInfo.sampleRate });

    const analyzeDiarizedRegions = async (words) => {
      for (const region of diarizedAudioRegions(words, { minimumDuration: 0.2 })) {
        const cacheKey = `${region.sourceSpeaker}:${region.start.toFixed(2)}:${region.end.toFixed(2)}`;
        if (analyzedRegions.has(cacheKey)) continue;
        const firstSample = Math.max(audioHistory.earliestSample, Math.floor(region.start * speakerModelInfo.sampleRate));
        const lastSample = Math.min(audioHistory.latestSample, Math.ceil(region.end * speakerModelInfo.sampleRate));
        if (lastSample - firstSample < speakerModelInfo.sampleRate) continue;
        const snapshot = audioHistory.slice(firstSample, lastSample);
        try {
          const pcm = new Int16Array(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength / 2);
          const chunkQuality = analyzePcmQuality(pcm, speakerModelInfo.sampleRate);
          if (!isSpeakerSignalQuality(chunkQuality)) continue;
          analyzedRegions.add(cacheKey);
          const accumulated = speakerAudioAccumulator.add(region.sourceSpeaker, pcm, region);
          if (!accumulated) {
            if (!identityTracker.hasEvidence(region.sourceSpeaker)) pendingSpeakerClusters.add(region.sourceSpeaker);
            continue;
          }
          const inferenceQuality = analyzePcmQuality(accumulated.pcm, speakerModelInfo.sampleRate);
          if (!isSpeakerInferenceQuality(inferenceQuality)) continue;
          const scores = await speakerModel.compare(accumulated.pcm, profiles);
          if (scores) {
            pendingSpeakerClusters.delete(region.sourceSpeaker);
            recognitionFrames.push({
              start: region.start,
              end: region.end,
              sourceSpeaker: region.sourceSpeaker,
              weight: Math.min(8, accumulated.newEvidenceSeconds) * Math.max(0.5, Math.min(1, inferenceQuality.snrDb / 20)),
              qualityScore: inferenceQuality.score,
              scores
            });
          }
        } catch (error) {
          console.error("Diarized speaker inference failed:", error);
        }
      }
    };

    const languageMap = { ko: "ko-KR", en: "en-US", ja: "ja" };
    const language = languageMap[requestUrl.searchParams.get("language")] || "ko-KR";
    const query = new URLSearchParams({
      model: "nova-3", language, encoding: "linear16", sample_rate: "16000", channels: "1",
      interim_results: "true", endpointing: "300", punctuate: "true", smart_format: "true"
    });
    if (mode === "speaker") query.set("diarize_model", "latest");
    const organizationTerms = await meetingStore.listVocabularyTerms(auth.organization.id, auth.user.vocabulary?.knownTerms || []);
    const keyterms = buildSttKeyterms({
      knownTerms: auth.user.vocabulary?.knownTerms || [],
      organizationTerms,
      speakerNames: speakers.map(({ name }) => name)
    });
    for (const keyterm of keyterms) query.append("keyterm", keyterm);
    deepgram = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
    });

    deepgram.on("open", () => client.readyState === WebSocket.OPEN && client.send(JSON.stringify({
      type: "ready", mode, sampleRate: speakerModelInfo.sampleRate, speakers: speakers.map(({ id, name }) => ({ id, name }))
    })));

    let transcriptQueue = Promise.resolve();
    let finalizationAcknowledged = false;
    let diarizationWarningSent = false;
    const acknowledgeFinalization = () => {
      if (finalizationAcknowledged) return;
      finalizationAcknowledged = true;
      clearTimeout(finalizeFallback);
      transcriptQueue.finally(() => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "finalized" }));
      });
    };
    deepgram.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type !== "Results") return;
      const alternative = event.channel?.alternatives?.[0];
      if (alternative?.words?.length) {
        transcriptQueue = transcriptQueue.then(async () => {
          const hasDiarizationLabels = alternative.words.some(({ speaker }) =>
            speaker != null && speaker !== "" && Number.isInteger(Number(speaker)) && Number(speaker) >= 0);
          if (mode === "speaker" && event.is_final && !hasDiarizationLabels && !diarizationWarningSent) {
            diarizationWarningSent = true;
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: "warning",
                message: "화자 분리 정보가 없는 구간을 받았습니다. 잘못된 이름을 붙이지 않고 ‘화자 정보 없음’으로 보존합니다. 계속되면 Deepgram diarization 설정을 확인해 주세요."
              }));
            }
          }
          if (mode === "speaker" && event.is_final) await analyzeDiarizedRegions(alternative.words);
          const segments = mode === "speaker"
            ? wordsToSegments(alternative.words, recognitionFrames, speakers, {
              threshold: Number(process.env.SPEAKER_MATCH_THRESHOLD) || 0.72,
              margin: Number(process.env.SPEAKER_MATCH_MARGIN) || 0.04,
              tracker: identityTracker,
              pendingSpeakerClusters
            })
            : wordsToTranscriptSegments(alternative.words);
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "transcript", isFinal: Boolean(event.is_final), speechFinal: Boolean(event.speech_final), segments }));
          }
          const earliestNeeded = Number(event.start ?? 0) - 4;
          while (recognitionFrames.length && recognitionFrames[0].end < earliestNeeded) recognitionFrames.shift();
        }).catch((error) => {
          console.error("Transcript processing failed:", error);
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "error", message: "실시간 화자 분석을 처리하지 못했습니다." }));
          }
        });
      }
      if (event.from_finalize) acknowledgeFinalization();
    });

    deepgram.on("error", (error) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", message: `실시간 STT 연결 오류: ${error.message}` }));
    });
    deepgram.on("close", () => client.readyState === WebSocket.OPEN && client.close(1011, "STT connection closed"));

    client.on("message", (data, isBinary) => {
      if (deepgram.readyState !== WebSocket.OPEN) return;
      if (!isBinary) {
        try {
          const control = JSON.parse(data.toString());
          if (control.type === "finalize" && !finalizationAcknowledged) {
            deepgram.send(JSON.stringify({ type: "Finalize" }));
            finalizeFallback = setTimeout(acknowledgeFinalization, 3_500);
          } else if (control.type === "speakerCorrection" && mode === "speaker" && identityTracker) {
            const sourceSpeaker = String(control.sourceSpeaker ?? "").slice(0, 40);
            const selected = speakers.find(({ name }) => name === String(control.speakerName || ""));
            if (sourceSpeaker && selected) {
              identityTracker.correct(sourceSpeaker, selected);
              client.send(JSON.stringify({ type: "speakerCorrectionAccepted", sourceSpeaker, speaker: selected.name }));
            }
          }
        } catch {
          // Ignore malformed client control messages without interrupting audio.
        }
        return;
      }
      const incoming = Buffer.from(data);
      deepgram.send(incoming);
      if (mode !== "speaker") return;
      audioHistory.append(incoming);
    });
  } catch (error) {
    console.error("Live session failed:", error);
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", message: error.message }));
    client.close(1011);
  }

  client.on("close", () => {
    clearTimeout(finalizeFallback);
    if (deepgram?.readyState === WebSocket.OPEN) {
      deepgram.send(JSON.stringify({ type: "CloseStream" }));
      deepgram.close();
    }
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: "info", event: "shutdown_started", signal }));
  for (const client of liveServer.clients) client.close(1012, "Server restarting");
  liveServer.close();
  const forcedExit = setTimeout(() => {
    console.error(JSON.stringify({ level: "error", event: "shutdown_forced", signal }));
    server.closeAllConnections?.();
    process.exit(1);
  }, 10_000);
  forcedExit.unref();
  server.close(async () => {
    closeSqliteDatabases();
    await closePostgresDatabases();
    clearTimeout(forcedExit);
    console.log(JSON.stringify({ level: "info", event: "shutdown_completed", signal }));
    process.exit(0);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
