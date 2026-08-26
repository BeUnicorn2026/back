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
import { migrateSpeakerProfiles, speakerProfileNeedsMigration } from "./lib/speaker-profile-migration.mjs";
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
import { RoomStore, RoomStoreError } from "./lib/room-store.mjs";
import { PostgresRoomStore } from "./lib/postgres-room-store.mjs";
import { VoiceProfileStore } from "./lib/voice-profile-store.mjs";
import { PostgresVoiceProfileStore } from "./lib/postgres-voice-profile-store.mjs";
import {
  bindRoomMeeting,
  publicRoom,
  publishSelfEnrollment,
  requireCanonicalVoice,
  requireRoomMember,
  resolveCanonicalVoice,
  roomErrorHttpStatus,
  validateSelfEnrollmentRequest,
  VoiceProfileError
} from "./lib/room-server-coordinator.mjs";
import { handleSelfOnlyRoomLive } from "./lib/room-live-connection.mjs";
import { RoomLiveHub } from "./lib/room-live-hub.mjs";
import { PostgresRequestRateLimiter } from "./lib/postgres-rate-limiter.mjs";
import { MeetingIntelligenceService, transcriptHash } from "./lib/meeting-intelligence.mjs";
import { PcmHistoryBuffer } from "./lib/pcm-history-buffer.mjs";
import { buildSttKeyterms } from "./lib/stt-keyterms.mjs";
import { conceptIdFor, normalizeConceptLabel } from "./lib/concept-label.mjs";
import { KnowledgeFilterService, personalizeKnowledgeTerms } from "./lib/knowledge-personalization.mjs";
import { TermExtractionService } from "./lib/term-extraction.mjs";
import { createNoopTermLiveBridge, createTermLiveBridge } from "./lib/term-live-bridge.mjs";
import { KnowledgeExplanationService, knowledgeExplanationCacheKey } from "./lib/knowledge-explanation.mjs";
import { normalizeUploadFilename, uploadTitle } from "./lib/upload-filename.mjs";
import { productionEnvironmentIssues, serviceReadiness } from "./lib/service-readiness.mjs";
import { createConcurrencyLimit } from "./lib/concurrency-limit.mjs";
import { expectedSpeakerScore, recordingEnvelopeSimilarity, speakerProbeFingerprint, speakerVerificationUpdate } from "./lib/speaker-verification.mjs";
import { sessionCookiePolicy } from "./lib/session-cookie-policy.mjs";
import { speakerRegionSampleRange } from "./lib/live-speaker-regions.mjs";
import { isSupportedAudioUpload } from "./lib/audio-upload.mjs";
import { selectSpeakerReferencePcm } from "./lib/speaker-reference.mjs";
import { canForwardLiveAudio } from "./lib/live-audio-backpressure.mjs";
import { buildDeepgramLiveQuery } from "./lib/deepgram-live-options.mjs";
import { createDeepgramKeepAlive, deepgramApplicationError, parseDeepgramLiveEvent } from "./lib/deepgram-live-connection.mjs";
import { BillingError, BillingStore } from "./lib/billing-store.mjs";
import { PostgresBillingStore } from "./lib/postgres-billing-store.mjs";
import { publicBillingPlans } from "./lib/billing-plans.mjs";
import { TossPaymentsClient, TossPaymentsError } from "./lib/toss-payments-client.mjs";
import { entitlementPeriodStart, meetingAllowance, planEntitlements } from "./lib/plan-entitlements.mjs";
import { GoMeetMapClient, mergeMeetMapIntelligence } from "./lib/go-meetmap-client.mjs";
import { MeetMapSubmissionTracker, persistSucceededMeetMapJob } from "./lib/meetmap-submission-tracker.mjs";
import {
  filterMeetingsForAccess,
  MeetingAuthorizationError,
  requireMeetingAccess
} from "./lib/meeting-authorization.mjs";
import { GoLiveMapClient, isLiveMapEnabled } from "./lib/go-livemap-client.mjs";
import { createLiveMapBridge, createNoopLiveMapBridge } from "./lib/livemap-live-bridge.mjs";

const app = express();
const port = Number(process.env.PORT) || 7070;
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
const roomStore = postgresDatabase
  ? new PostgresRoomStore(postgresDatabase)
  : new RoomStore(path.join(dataDirectory, "rooms"), { databasePath });
const voiceProfileStore = postgresDatabase
  ? new PostgresVoiceProfileStore(postgresDatabase)
  : new VoiceProfileStore(databasePath);
const billingStore = postgresDatabase
  ? new PostgresBillingStore(postgresDatabase)
  : new BillingStore(databasePath);
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
const goMeetMapClient = new GoMeetMapClient({
  origin: process.env.GO_AI_ORIGIN,
  token: process.env.AI_API_TOKEN
});
const meetMapSubmissions = new MeetMapSubmissionTracker();
const goLiveMapClient = new GoLiveMapClient({
  origin: process.env.GO_AI_ORIGIN,
  token: process.env.AI_API_TOKEN
});
const knowledgeExplanationService = new KnowledgeExplanationService({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_EXPLANATION_MODEL || process.env.OPENAI_ANALYSIS_MODEL
});
const knowledgeFilterService = new KnowledgeFilterService({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_FILTER_MODEL || process.env.OPENAI_EXPLANATION_MODEL || process.env.OPENAI_ANALYSIS_MODEL
});
const termExtractionService = new TermExtractionService({
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_TERMS_MODEL || process.env.OPENAI_ANALYSIS_MODEL
});
// 실시간 용어 푸시: OpenAI 키가 없으면 브리지를 아예 만들지 않아 오버헤드가 0이다.
const termBridgeFactory = termExtractionService.mode === "openai"
  ? ({ participants, meetingTopic, log }) => createTermLiveBridge({
    extraction: termExtractionService,
    filter: knowledgeFilterService,
    participants,
    meetingTopic,
    log
  })
  : null;
const tossPayments = new TossPaymentsClient({
  clientKey: process.env.TOSS_CLIENT_KEY,
  secretKey: process.env.TOSS_SECRET_KEY
});
const speakerModelCache = process.env.SPEAKER_MODEL_CACHE || path.join(projectDirectory, ".cache", "speaker-models");
const speakerModelPath = process.env.SPEAKER_MODEL_PATH || "";
// 화자 recognition 모델은 판정 품질을 다시 검증할 때까지 비활성화한다.
// const speakerRecognitionEnabled = process.env.SPEAKER_RECOGNITION_ENABLED !== "false";
// const shouldPreloadSpeakerModel = process.env.PRELOAD_SPEAKER_MODEL === "true"
//   || (process.env.NODE_ENV === "production" && process.env.PRELOAD_SPEAKER_MODEL !== "false");
const speakerRecognitionEnabled = false;
const shouldPreloadSpeakerModel = false;
let speakerModelState = "disabled";
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

function transcriptProfileForCurrentUser(auth) {
  return {
    id: null,
    speakerProfileId: null,
    createdBy: auth.user.id,
    userId: auth.user.id,
    name: auth.user.name,
    displayName: auth.user.name,
    profiles: []
  };
}

async function roomTranscriptProfile(auth) {
  // 화자 recognition을 다시 켤 때만 회의 입장 전에 등록 프로필을 요구한다.
  // return (await requireCanonicalVoice({ voiceProfileStore, speakerStore, auth })).profile;
  if (speakerRecognitionEnabled) {
    return (await requireCanonicalVoice({ voiceProfileStore, speakerStore, auth })).profile;
  }
  return transcriptProfileForCurrentUser(auth);
}
const maxAudioBytes = 25 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxAudioBytes, files: 1 },
  fileFilter(_request, file, callback) {
    callback(null, isSupportedAudioUpload(file));
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
const liveMeetMapRateLimit = rateLimit("live-meetmap", { limit: 120, windowMs: 60 * 60_000 }, (request) =>
  `${request.auth?.organization?.id || "none"}:${request.auth?.user?.id || request.ip}`);
const speakerEnrollmentRateLimit = rateLimit("speaker-enrollment", { limit: 12, windowMs: 60 * 60_000 }, (request) =>
  `${request.auth?.organization?.id || "none"}:${request.auth?.user?.id || request.ip}`);
const speakerIdentificationRateLimit = rateLimit("speaker-identification", { limit: 30, windowMs: 60 * 60_000 }, (request) =>
  `${request.auth?.organization?.id || "none"}:${request.auth?.user?.id || request.ip}`);
const knowledgeExplanationRateLimit = rateLimit("knowledge-explanation", { limit: 30, windowMs: 60 * 60_000 }, (request) =>
  request.auth?.user?.id || request.ip);
const transcriptionRateLimit = rateLimit("transcription", { limit: 12, windowMs: 60 * 60_000 }, (request) =>
  `${request.auth?.organization?.id || "none"}:${request.auth?.user?.id || request.ip}`);
const billingOrderRateLimit = rateLimit("billing-order", { limit: 10, windowMs: 60 * 60_000 }, (request) =>
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

function sessionCookieOptions(request) {
  return sessionCookiePolicy({
    environment: process.env.NODE_ENV,
    configuredSameSite: process.env.SESSION_COOKIE_SAME_SITE,
    serverOrigin: requestOrigin(request),
    clientOrigin: request.headers.origin
  });
}

function setSessionCookie(request, response, token, expiresAt) {
  response.cookie(sessionCookieName, token, {
    ...sessionCookieOptions(request),
    expires: new Date(expiresAt)
  });
}

function clearSessionCookie(request, response) {
  response.clearCookie(sessionCookieName, sessionCookieOptions(request));
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
    knowledgeFilter: knowledgeFilterService.mode,
    termExtraction: termExtractionService.mode,
    knowledgePersistence: "memory-only",
    database: databaseMode,
    speakerStorage: speakerStorageMode,
    speakerModel: speakerModelInfo.id,
    speakerInference: speakerInferenceInfo,
    speakerModelState,
    payments: tossPayments.mode
  };
}

async function billingSnapshot(organizationId, now = new Date()) {
  const subscription = await billingStore.subscriptionForOrganization(organizationId, now);
  const entitlements = planEntitlements(subscription);
  const periodStart = entitlementPeriodStart(subscription, now);
  const persistedMeetings = await meetingStore.countSince(organizationId, periodStart);
  const usedMeetings = await billingStore.meetingUsageForPeriod({
    organizationId,
    periodStart,
    baselineUsed: persistedMeetings,
    now
  });
  return {
    subscription,
    entitlements,
    periodStart,
    meetingUsage: meetingAllowance(entitlements, usedMeetings)
  };
}

async function reserveMeetingAllowance(organizationId, usageKey, now = new Date()) {
  const snapshot = await billingSnapshot(organizationId, now);
  const reservation = await billingStore.consumeMeeting({
    organizationId,
    periodStart: snapshot.periodStart,
    limit: snapshot.entitlements.meetingsPerPeriod,
    usageKey,
    baselineUsed: snapshot.meetingUsage.used,
    now
  });
  return { ...snapshot, reservation };
}

async function releaseMeetingAllowance(organizationId, periodStart, usageKey) {
  await billingStore.releaseMeeting({ organizationId, periodStart, usageKey });
}

async function requireMeetingAllowance(organizationId) {
  const snapshot = await billingSnapshot(organizationId);
  if (!snapshot.meetingUsage.allowed) {
    throw new BillingError(
      `${snapshot.entitlements.planId} 플랜의 현재 기간 회의 ${snapshot.meetingUsage.limit}회를 모두 사용했습니다.`,
      402,
      "PLAN_MEETING_LIMIT"
    );
  }
  return snapshot;
}

async function requireDurationAllowance(organizationId, durationSeconds) {
  const snapshot = await billingSnapshot(organizationId);
  if (snapshot.entitlements.meetingDurationSeconds != null && Number(durationSeconds) > snapshot.entitlements.meetingDurationSeconds) {
    throw new BillingError(
      `${snapshot.entitlements.planId} 플랜의 회의당 최대 녹음 시간을 초과했습니다.`,
      402,
      "PLAN_DURATION_LIMIT"
    );
  }
  return snapshot;
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
  const { familiarKeys, source } = await knowledgeFilterService.familiarTerms({
    userId: user.id,
    introduction: user.introduction || "",
    candidateTerms: terms.map(({ term, definition }) => ({ term, definition })),
    knownTerms
  });
  return personalizeKnowledgeTerms(terms, { familiarKeys, knownTerms, source });
}

async function personalizedIntelligenceFor(user, intelligence) {
  if (!intelligence) return null;
  return { ...intelligence, terms: await personalizedTermsFor(user, intelligence.terms || []) };
}

// 맞춤 해설은 클릭 파생 데이터를 DB에 남기지 않는 방침에 따라 메모리에만 캐시한다.
// 프로세스가 재시작되면 같은 클릭이 LLM을 다시 호출할 뿐, 잃는 데이터는 없다.
const explanationCache = new Map(); // `${userId}:${cacheKey}` -> { explanation, at }
const EXPLANATION_CACHE_LIMIT = 1_000;
const EXPLANATION_CACHE_TTL_MS = 6 * 60 * 60_000;

function readExplanationCache(userId, cacheKey) {
  const key = `${userId}:${cacheKey}`;
  const entry = explanationCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > EXPLANATION_CACHE_TTL_MS) {
    explanationCache.delete(key);
    return null;
  }
  return entry.explanation;
}

function writeExplanationCache(userId, cacheKey, explanation) {
  explanationCache.set(`${userId}:${cacheKey}`, { explanation, at: Date.now() });
  while (explanationCache.size > EXPLANATION_CACHE_LIMIT) {
    explanationCache.delete(explanationCache.keys().next().value);
  }
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

  // 화자 recognition 재활성화 시 등록 음성 참조와 후처리 판정을 복구한다.
  // const allKnownSpeakers = await loadCurrentSpeakerProfiles(organizationId);
  const allKnownSpeakers = [];
  const knownSpeakerReferences = [];
  for (const speaker of allKnownSpeakers) {
    if (knownSpeakerReferences.length >= 4) break;
    if (!Buffer.isBuffer(speaker.referenceAudio) || !speaker.referenceAudio.length) continue;
    try {
      const decodedReference = await decodeToPcm(speaker.referenceAudio);
      const decodedSamples = new Int16Array(
        decodedReference.buffer,
        decodedReference.byteOffset,
        Math.floor(decodedReference.byteLength / 2)
      );
      const referenceSamples = selectSpeakerReferencePcm(decodedSamples);
      const duration = referenceSamples.length / speakerModelInfo.sampleRate;
      const referenceQuality = analyzePcmQuality(referenceSamples, speakerModelInfo.sampleRate);
      if (duration < 2 || duration > 10 || !isSpeakerInferenceQuality(referenceQuality)) continue;
      knownSpeakerReferences.push({
        name: speaker.name,
        audio: pcmToWave(Buffer.from(referenceSamples.buffer, referenceSamples.byteOffset, referenceSamples.byteLength))
      });
    } catch (error) {
      console.error(`Known speaker reference skipped (${speaker.id}):`, error.message);
    }
  }
  if (knownSpeakerReferences.length) {
    form.append("known_speaker_names", JSON.stringify(knownSpeakerReferences.map(({ name }) => name)));
    form.append("known_speaker_references", JSON.stringify(knownSpeakerReferences.map(({ audio }) =>
      `data:audio/wav;base64,${audio.toString("base64")}`)));
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
  const normalized = normalizeTranscript(payload, { knownSpeakers: knownSpeakerReferences.map(({ name }) => name) });
  // if (!allKnownSpeakers.length) return normalized;
  // try {
  //   const decoded = await decodeToPcm(file.buffer, 1_800);
  //   const originalPcm = new Int16Array(decoded.buffer, decoded.byteOffset, Math.floor(decoded.byteLength / 2));
  //   const model = await getSpeakerEmbeddingModel(speakerModelCache, speakerModelPath);
  //   return await reconcileTranscriptSpeakers(normalized, originalPcm, allKnownSpeakers, model, {
  //     threshold: Number(process.env.SPEAKER_MATCH_THRESHOLD) || speakerModelInfo.defaultMatchThreshold,
  //     margin: Number(process.env.SPEAKER_MATCH_MARGIN) || speakerModelInfo.defaultMatchMargin
  //   });
  // } catch (speakerError) {
  //   console.error("Final speaker reconciliation failed:", speakerError);
  //   return normalized;
  // }
  return normalized;
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

const speakerProfileMigrationPromises = new Map();

async function loadCurrentSpeakerProfiles(organizationId) {
  const speakers = await speakerStore.loadProfiles(organizationId);
  if (!speakers.some((speaker) => speakerProfileNeedsMigration(speaker, speakerModelInfo))) return speakers;

  let migration = speakerProfileMigrationPromises.get(organizationId);
  if (!migration) {
    migration = (async () => {
      const model = await prepareSpeakerModel();
      const migrated = await migrateSpeakerProfiles(speakers, {
        model,
        modelInfo: speakerModelInfo,
        decodeReference: async (referenceAudio) => {
          const decoded = await decodeToPcm(referenceAudio);
          return new Int16Array(decoded.buffer, decoded.byteOffset, Math.floor(decoded.byteLength / 2));
        },
        replace: (metadata, profile, referenceAudio) =>
          speakerStore.replace(metadata, profile, referenceAudio, organizationId)
      });
      if (migrated.length) {
        console.log(JSON.stringify({ level: "info", event: "speaker_profiles_migrated", organizationId, migrated }));
      }
    })().finally(() => speakerProfileMigrationPromises.delete(organizationId));
    speakerProfileMigrationPromises.set(organizationId, migration);
  }
  await migration;
  return speakerStore.loadProfiles(organizationId);
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
  setSessionCookie(request, response, session.token, session.expiresAt);
  response.json({ authenticated: true, ...await authStore.getContextBySession(session.token) });
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
  setSessionCookie(request, response, session.token, session.expiresAt);
  response.json({ authenticated: true, ...await authStore.getContextBySession(session.token) });
});

app.post("/api/auth/logout", requireTrustedOrigin, requireAuth, requireCsrf, async (request, response) => {
  await authStore.deleteSession(sessionToken(request));
  clearSessionCookie(request, response);
  response.status(204).end();
});

app.get("/api/session", optionalAuth, async (request, response) => {
  if (!request.auth) return response.json({ authenticated: false });
  response.json({ authenticated: true, ...request.auth });
});

app.get("/api/billing", requireAuth, requireOrganization, async (request, response) => {
  const snapshot = await billingSnapshot(request.auth.organization.id);
  const speakerCount = (await speakerStore.list(request.auth.organization.id)).length;
  response.json({
    plans: publicBillingPlans(),
    subscription: snapshot.subscription,
    entitlements: snapshot.entitlements,
    usage: {
      meetings: snapshot.meetingUsage,
      speakers: {
        used: speakerCount,
        limit: snapshot.entitlements.speakerProfiles,
        remaining: Math.max(0, snapshot.entitlements.speakerProfiles - speakerCount)
      },
      periodStart: snapshot.periodStart
    },
    payment: tossPayments.publicConfiguration()
  });
});

app.post("/api/billing/orders", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  billingOrderRateLimit, async (request, response) => {
    const order = await billingStore.createOrder({
      userId: request.auth.user.id,
      organizationId: request.auth.organization.id,
      planId: request.body?.planId
    });
    response.status(201).json({
      orderId: order.orderId,
      planId: order.planId,
      amount: order.amount,
      orderName: `SSU-ON ${order.planId} 30일 이용권`,
      expiresAt: order.expiresAt
    });
  });

app.post("/api/billing/confirm", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  billingOrderRateLimit, async (request, response) => {
    const orderId = String(request.body?.orderId || "");
    const paymentKey = String(request.body?.paymentKey || "");
    const amount = Number(request.body?.amount);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(orderId) || !paymentKey || paymentKey.length > 200 || !Number.isSafeInteger(amount)) {
      throw new BillingError("올바른 결제 승인 정보가 필요합니다.", 400, "PAYMENT_CONFIRM_INVALID");
    }
    const claim = await billingStore.beginConfirmation({ orderId, userId: request.auth.user.id, amount });
    if (claim.order.organizationId !== request.auth.organization.id) {
      await billingStore.releaseConfirmation(orderId);
      throw new BillingError("현재 조직의 결제 주문이 아닙니다.", 403, "PAYMENT_ORGANIZATION_MISMATCH");
    }
    if (claim.alreadyConfirmed) {
      return response.json({
        confirmed: true,
        subscription: await billingStore.subscriptionForOrganization(request.auth.organization.id)
      });
    }
    try {
      const payment = await tossPayments.confirm({ paymentKey, orderId, amount: claim.order.amount });
      const completed = await billingStore.completeConfirmation({ orderId, userId: request.auth.user.id, payment });
      return response.json({ confirmed: true, subscription: completed.subscription });
    } catch (error) {
      await billingStore.releaseConfirmation(orderId);
      throw error;
    }
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

app.put("/api/profile", requireTrustedOrigin, requireAuth, requireCsrf, async (request, response) => {
  response.json({ authenticated: true, ...await authStore.updateProfile(request.auth.user.id, request.body || {}) });
});

app.put("/api/profile/vocabulary", requireTrustedOrigin, requireAuth, requireCsrf, async (request, response) => {
  response.json(await authStore.updateVocabulary(request.auth.user.id, request.body || {}));
});

app.get("/api/profile/voice", requireAuth, requireOrganization, async (request, response) => {
  const resolved = await resolveCanonicalVoice({ voiceProfileStore, speakerStore, auth: request.auth });
  response.json({
    state: resolved.state,
    ...(resolved.state === "ready" ? {
      profile: {
        speakerProfileId: resolved.profile.speakerProfileId,
        displayName: resolved.profile.displayName,
        updatedAt: resolved.pointer.updatedAt
      }
    } : {})
  });
});

app.post("/api/profile/voice/enroll", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  speakerEnrollmentRateLimit, upload.single("audio"), async (request, response) => {
    validateSelfEnrollmentRequest(request.body || {});
    if (!request.file) return response.status(400).json({ error: "등록할 음성 파일이 필요합니다.", code: "VOICE_AUDIO_REQUIRED" });
    const pcm = await decodeToPcm(request.file.buffer, 16);
    const duration = pcm.length / 2 / speakerModelInfo.sampleRate;
    if (duration < 10 || duration > 15) {
      return response.status(400).json({
        error: "등록 음성은 10초 이상 15초 이하여야 합니다.",
        code: "VOICE_DURATION_INVALID"
      });
    }
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    const quality = analyzePcmQuality(samples, speakerModelInfo.sampleRate);
    if (!quality.usable || !isSpeakerInferenceQuality(quality)) {
      return response.status(422).json({
        error: quality.warnings[0] || "등록 음성 품질이 충분하지 않습니다.",
        code: "VOICE_QUALITY_INVALID",
        quality
      });
    }
    const profile = await enrollProfile(pcm);
    const selectedReference = selectSpeakerReferencePcm(samples);
    const referenceAudio = pcmToWave(Buffer.from(
      selectedReference.buffer,
      selectedReference.byteOffset,
      selectedReference.byteLength
    ));
    const enrolledAt = new Date().toISOString();
    const published = await publishSelfEnrollment({
      voiceProfileStore,
      speakerStore,
      auth: request.auth,
      profileBuffer: profile.buffer,
      referenceAudio,
      metadata: {
        duration,
        model: speakerModelInfo.id,
        profileCount: profile.count,
        profileDimensions: speakerModelInfo.dimensions,
        enrollmentConsistency: profile.consistency,
        matchThreshold: profile.matchThreshold,
        audioQuality: quality,
        enrollmentSessionCount: 1,
        totalEnrollmentDuration: duration,
        lastEnrolledAt: enrolledAt,
        enrollmentSessions: [{ duration, qualityScore: quality.score, enrolledAt }],
        enrollmentFingerprints: [speakerProbeFingerprint(samples)]
      }
    });
    response.status(201).json({
      state: "ready",
      profile: {
        speakerProfileId: published.pointer.speakerProfileId,
        displayName: request.auth.user.name,
        updatedAt: published.pointer.updatedAt
      }
    });
  });

app.get("/api/vocabulary/terms", requireAuth, requireOrganization, async (request, response) => {
  const terms = await meetingStore.listVocabularyTerms(
    request.auth.organization.id,
    request.auth.user.vocabulary?.knownTerms || []
  );
  response.json({ terms: await personalizedTermsFor(request.auth.user, terms) });
});

app.post("/api/knowledge/explanations", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  knowledgeExplanationRateLimit, async (request, response) => {
    const meetingId = String(request.body?.meetingId || "").trim();
    const requestedTerm = normalizeConceptLabel(request.body?.term);
    const level = ["simple", "standard", "deep"].includes(request.body?.level) ? request.body.level : "simple";
    if (!meetingId || !requestedTerm) return response.status(400).json({ error: "회의와 용어가 필요합니다." });
    const meeting = await requireMeetingAccess({ meetingStore, roomStore, meetingId, auth: request.auth });
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
    const introduction = request.auth.user.introduction || "";
    const cacheKey = knowledgeExplanationCacheKey({
      term: analyzedTerm.term,
      definition,
      context,
      introduction,
      level,
      model: `${knowledgeExplanationService.mode}:${knowledgeExplanationService.model}`
    });
    const cached = readExplanationCache(request.auth.user.id, cacheKey);
    if (cached) return response.json({ explanation: cached, cached: true });
    try {
      const result = await knowledgeExplanationService.generate({
        userId: request.auth.user.id,
        term: analyzedTerm.term,
        definition,
        context,
        introduction,
        level
      });
      const explanation = {
        cacheKey,
        conceptId: conceptIdFor(analyzedTerm.term),
        term: normalizeConceptLabel(analyzedTerm.term),
        level,
        explanation: result.explanation,
        originalSentence: result.originalSentence || "",
        rewrittenContext: result.rewrittenContext || "",
        analogy: result.analogy,
        source: result.source,
        model: result.model,
        meetingId: meeting.id,
        segmentIndex,
        generatedAt: new Date().toISOString()
      };
      writeExplanationCache(request.auth.user.id, cacheKey, explanation);
      return response.status(201).json({ explanation, cached: false });
    } catch (error) {
      console.error("Knowledge explanation failed:", error);
      return response.status(error?.name === "AbortError" ? 504 : 502).json({
        error: error?.name === "AbortError"
          ? "맞춤 해설 생성 시간이 초과되었습니다."
          : "맞춤 해설을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요."
      });
    }
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

app.post("/api/rooms", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  // await requireCanonicalVoice({ voiceProfileStore, speakerStore, auth: request.auth });
  const room = await roomStore.create({
    organizationId: request.auth.organization.id,
    createdBy: request.auth.user.id,
    room: request.body?.room,
    idempotencyKey: request.headers["idempotency-key"] || request.body?.idempotencyKey
  });
  response.status(201).json({ room: publicRoom(room, { includeAccessCode: true }) });
});

app.post("/api/rooms/join", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  // await requireCanonicalVoice({ voiceProfileStore, speakerStore, auth: request.auth });
  const room = await roomStore.join({
    organizationId: request.auth.organization.id,
    userId: request.auth.user.id,
    accessCode: request.body?.accessCode
  });
  response.json({ room: publicRoom(room) });
});

app.get("/api/rooms", requireAuth, requireOrganization, async (request, response) => {
  const rooms = await roomStore.listForUser(request.auth.user.id, request.auth.organization.id);
  response.json({ rooms: rooms.map((room) => publicRoom(room)) });
});

app.get("/api/rooms/:id", requireAuth, requireOrganization, async (request, response) => {
  const room = await requireRoomMember({ roomStore, roomId: request.params.id, auth: request.auth, requireActive: false });
  response.json({ room: publicRoom(room) });
});

app.post("/api/rooms/:id/close", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  await requireRoomMember({ roomStore, roomId: request.params.id, auth: request.auth, requireActive: false });
  const room = await roomStore.close(request.params.id, request.auth.organization.id, request.auth.user.id);
  await roomLiveHub.closeRoom(room.id);
  response.json({ room: publicRoom(room) });
});

app.post("/api/rooms/:id/meetings", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  const room = await requireRoomMember({ roomStore, roomId: request.params.id, auth: request.auth });
  // await requireCanonicalVoice({ voiceProfileStore, speakerStore, auth: request.auth });
  const meeting = await bindRoomMeeting({
    meetingStore,
    room,
    auth: request.auth,
    language: request.body?.language,
    requestedMeetingId: request.body?.meetingId
  });
  response.status(201).json({ meeting });
});

app.get("/api/meetings", requireAuth, requireOrganization, async (request, response) => {
  const meetings = await meetingStore.list(request.auth.organization.id);
  response.json({ meetings: await filterMeetingsForAccess({ meetings, roomStore, auth: request.auth }) });
});

app.get("/api/meetings/:id", requireAuth, requireOrganization, async (request, response) => {
  const meeting = await requireMeetingAccess({
    meetingStore,
    roomStore,
    meetingId: request.params.id,
    auth: request.auth
  });
  response.json({ meeting });
});

app.post("/api/meetmap/jobs", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  liveMeetMapRateLimit, async (request, response) => {
    const tenantKey = `${request.auth.organization.id}:${request.auth.user.id}`;
    try {
      const meetingId = typeof request.body?.meetingId === "string" ? request.body.meetingId : "";
      if (meetingId) {
        await requireMeetingAccess({ meetingStore, roomStore, meetingId, auth: request.auth });
      }
      const segments = Array.isArray(request.body?.segments) ? request.body.segments : [];
      const result = await goMeetMapClient.submit({ meetingId, segments, tenantKey });
      if (meetingId && result?.job?.id) {
        meetMapSubmissions.track(result.job.id, {
          meetingId,
          organizationId: request.auth.organization.id,
          tenantKey,
          segments
        });
      }
      return response.status(202).json(result);
    } catch (error) {
      console.error("Go MeetMap submission failed:", error);
      return response.status(Number(error?.status) || 502).json({ error: error.message || "대화 구조 분석을 시작하지 못했습니다." });
    }
  });

app.get("/api/meetmap/jobs/:id", requireAuth, requireOrganization, async (request, response) => {
  const tenantKey = `${request.auth.organization.id}:${request.auth.user.id}`;
  try {
    const result = await goMeetMapClient.get(request.params.id, tenantKey);
    // Consume tracking for terminal jobs (succeeded/failed) so completed jobs
    // never leak; persist only when the current transcript still matches what was
    // submitted for this job id.
    const trackedSubmission = meetMapSubmissions.peek(request.params.id);
    if (trackedSubmission?.tenantKey === tenantKey && trackedSubmission.meetingId) {
      await requireMeetingAccess({
        meetingStore,
        roomStore,
        meetingId: trackedSubmission.meetingId,
        auth: request.auth
      });
    }
    const submission = meetMapSubmissions.takeTerminal(request.params.id, result.job?.status);
    if (result.job?.status === "succeeded" && submission?.tenantKey === tenantKey) {
      await persistSucceededMeetMapJob({
        job: result.job,
        submission,
        organizationId: request.auth.organization.id,
        meetingStore
      });
    }
    return response.json(result);
  } catch (error) {
    return response.status(Number(error?.status) || 502).json({ error: error.message || "대화 구조 분석 상태를 확인하지 못했습니다." });
  }
});

app.get("/api/meetings/:id/meetmap", requireAuth, requireOrganization, async (request, response) => {
  const meeting = await requireMeetingAccess({
    meetingStore,
    roomStore,
    meetingId: request.params.id,
    auth: request.auth
  });
  const intelligence = await meetingStore.getIntelligence(
    meeting.id,
    request.auth.organization.id,
    transcriptHash(meeting.segments)
  );
  response.json({ meetMap: intelligence?.meetMap || null });
});

app.post("/api/meetings", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  const organizationId = request.auth.organization.id;
  const usageKey = `meeting:${randomUUID()}`;
  const access = await reserveMeetingAllowance(organizationId, usageKey);
  try {
    const meeting = await meetingStore.create({
      organizationId,
      createdBy: request.auth.user.id,
      language: request.body?.language,
      source: request.body?.source,
      mode: request.body?.mode,
      title: request.body?.title
    });
    response.status(201).json({ meeting });
  } catch (error) {
    await releaseMeetingAllowance(organizationId, access.periodStart, usageKey);
    throw error;
  }
});

app.post("/api/meetings/import", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  transcriptionRateLimit, transcriptionConcurrencyLimit, upload.single("audio"), async (request, response) => {
    if (!request.file) return response.status(400).json({ error: "지원되는 오디오 파일이 필요합니다." });
    let usageReservation = null;
    try {
      const language = typeof request.body?.language === "string" ? request.body.language.trim() : "";
      const importKey = typeof request.body?.importId === "string" ? request.body.importId.trim() : "";
      if (!/^[a-f0-9-]{36}$/i.test(importKey)) return response.status(400).json({ error: "유효한 업로드 ID가 필요합니다." });
      const existing = await meetingStore.getByImportKey(request.auth.organization.id, importKey);
      if (existing) return response.json({ meeting: existing, duplicate: true });
      if (!process.env.OPENAI_API_KEY) return response.status(503).json({ error: "OPENAI_API_KEY가 설정되지 않았습니다." });
      const usageKey = `import:${importKey}`;
      usageReservation = { usageKey, ...await reserveMeetingAllowance(request.auth.organization.id, usageKey) };
      const transcription = await transcribeAudioFile(request.file, language, request.auth.organization.id);
      if (!transcription.segments?.length) return response.status(422).json({ error: "인식된 대화가 없습니다." });
      await requireDurationAllowance(request.auth.organization.id, transcription.duration);
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
      if (usageReservation && !usageReservation.reservation.duplicate) {
        await releaseMeetingAllowance(request.auth.organization.id, usageReservation.periodStart, usageReservation.usageKey);
      }
      if (error instanceof BillingError) throw error;
      return transcriptionErrorResponse(error, response);
    }
  });

app.patch("/api/meetings/:id", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  const existing = await requireMeetingAccess({
    meetingStore,
    roomStore,
    meetingId: request.params.id,
    auth: request.auth
  });
  if (existing.roomId && request.body?.segments !== undefined) {
    throw new MeetingAuthorizationError(
      "ROOM_TRANSCRIPT_MUTATION_FORBIDDEN",
      "방 회의의 확정 발화는 전체 대화 업데이트로 변경할 수 없습니다.",
      409
    );
  }
  const roomLifecycleField = ["status", "startedAt", "endedAt", "roomId", "createdBy"]
    .find((field) => Object.prototype.hasOwnProperty.call(request.body || {}, field));
  if (existing.roomId && roomLifecycleField) {
    throw new MeetingAuthorizationError(
      "ROOM_MEETING_LIFECYCLE_FORBIDDEN",
      "방 회의의 진행 상태는 방 수명 주기에 따라 서버에서만 변경됩니다.",
      409
    );
  }
  if (request.body?.duration != null) await requireDurationAllowance(request.auth.organization.id, request.body.duration);
  const meeting = await meetingStore.update(existing.id, request.auth.organization.id, request.body || {});
  response.json({ meeting });
});

app.delete("/api/meetings/:id", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  if (!/^[a-f0-9-]{36}$/i.test(request.params.id)) return response.status(400).json({ error: "잘못된 회의 ID입니다." });
  const meeting = await requireMeetingAccess({
    meetingStore,
    roomStore,
    meetingId: request.params.id,
    auth: request.auth
  });
  if (meeting.roomId) {
    const room = await roomStore.get(meeting.roomId, request.auth.organization.id);
    if (!room || room.createdBy !== request.auth.user.id) {
      throw new MeetingAuthorizationError(
        "ROOM_MEETING_CREATOR_REQUIRED",
        "방 회의는 방 생성자만 삭제할 수 있습니다.",
        403
      );
    }
  }
  await meetingStore.remove(meeting.id, request.auth.organization.id);
  response.status(204).end();
});

app.get("/api/meetings/:id/intelligence", requireAuth, requireOrganization, async (request, response) => {
  const meeting = await requireMeetingAccess({
    meetingStore,
    roomStore,
    meetingId: request.params.id,
    auth: request.auth
  });
  const hash = transcriptHash(meeting.segments);
  const intelligence = await meetingStore.getIntelligence(meeting.id, request.auth.organization.id, hash);
  response.json({ intelligence: await personalizedIntelligenceFor(request.auth.user, intelligence) });
});

app.post("/api/meetings/:id/intelligence", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  meetingAnalysisRateLimit, async (request, response) => {
    const meeting = await requireMeetingAccess({
      meetingStore,
      roomStore,
      meetingId: request.params.id,
      auth: request.auth
    });
    if (!meeting.segments.length) return response.status(409).json({ error: "분석할 실제 발화가 없습니다." });
    const hash = transcriptHash(meeting.segments);
    if (!request.body?.force) {
      const cached = await meetingStore.getIntelligence(meeting.id, request.auth.organization.id, hash);
      if (cached) {
        const cachedMeeting = cached.title && cached.title !== meeting.title
          ? await meetingStore.update(meeting.id, request.auth.organization.id, { title: cached.title })
          : meeting;
        return response.json({
          intelligence: await personalizedIntelligenceFor(request.auth.user, cached),
          meeting: cachedMeeting,
          cached: true
        });
      }
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
      const updatedMeeting = await meetingStore.get(meeting.id, request.auth.organization.id);
      return response.json({
        intelligence: await personalizedIntelligenceFor(request.auth.user, intelligence),
        meeting: updatedMeeting,
        cached: false
      });
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
    const existing = await loadCurrentSpeakerProfiles(request.auth.organization.id);
    const access = await billingSnapshot(request.auth.organization.id);
    if (existing.some((speaker) => speaker.createdBy === request.auth.user.id)) {
      return response.status(409).json({ error: "목소리는 사용자 본인당 한 개만 등록할 수 있습니다. 기존 프로필에 샘플을 추가해 주세요." });
    }
    if (existing.length >= access.entitlements.speakerProfiles) {
      throw new BillingError(
        `${access.entitlements.planId} 플랜은 등록 화자를 ${access.entitlements.speakerProfiles}명까지 지원합니다.`,
        402,
        "PLAN_SPEAKER_LIMIT"
      );
    }
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
    const selectedReference = selectSpeakerReferencePcm(samples);
    const referenceAudio = pcmToWave(Buffer.from(
      selectedReference.buffer,
      selectedReference.byteOffset,
      selectedReference.byteLength
    ));
    const storedSpeaker = await speakerStore.save(speaker, profile.buffer, referenceAudio);
    return response.status(201).json({ speaker: publicSpeakerProfile(storedSpeaker) });
  } catch (error) {
    if (error instanceof BillingError) throw error;
    console.error("Speaker enrollment failed:", error);
    return response.status(422).json({ error: error.message || "목소리를 등록하지 못했습니다." });
  }
});

app.post("/api/speakers/identify", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  speakerIdentificationRateLimit, upload.single("voice"), async (request, response) => {
    if (!speakerRecognitionEnabled) {
      return response.status(503).json({
        error: "목소리 인식 기능을 일시 중지했습니다.",
        code: "SPEAKER_RECOGNITION_DISABLED"
      });
    }
    if (!request.file) return response.status(400).json({ error: "식별할 MP3 또는 WAV 음성이 필요합니다." });
    try {
      const speakers = await loadCurrentSpeakerProfiles(request.auth.organization.id);
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
        threshold: Number(process.env.SPEAKER_MATCH_THRESHOLD) || speakerModelInfo.defaultMatchThreshold,
        margin: Number(process.env.SPEAKER_MATCH_MARGIN) || speakerModelInfo.defaultMatchMargin
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
      const verificationScore = expectedSpeakerScore(scores, speakers, expectedSpeakerId, decision.bestScore);
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
        score: verificationScore,
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
          }),
          ...(expectedSpeaker ? { expectedSpeakerScore: verificationScore } : {})
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
    const registeredSpeakers = await loadCurrentSpeakerProfiles(request.auth.organization.id);
    const existing = registeredSpeakers.find(({ id }) => id === request.params.id);
    if (!existing) return response.status(404).json({ error: "등록된 목소리를 찾지 못했습니다." });
    if (!existing.createdBy || existing.createdBy !== request.auth.user.id) return response.status(403).json({ error: "본인의 목소리 프로필만 변경할 수 있습니다." });
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
    const selectedReference = selectSpeakerReferencePcm(samples);
    const referenceAudio = quality.score > (existing.audioQuality?.score || 0)
      ? pcmToWave(Buffer.from(selectedReference.buffer, selectedReference.byteOffset, selectedReference.byteLength))
      : existing.referenceAudio;
    const storedSpeaker = await speakerStore.replaceOwned(updated, profileBuffer, referenceAudio, request.auth.user.id);
    if (!storedSpeaker) return response.status(403).json({ error: "본인의 목소리 프로필만 변경할 수 있습니다." });
    return response.json({ speaker: publicSpeakerProfile(storedSpeaker) });
  } catch (error) {
    console.error("Speaker sample enrollment failed:", error);
    return response.status(422).json({ error: error.message || "추가 목소리를 등록하지 못했습니다." });
  }
});

app.delete("/api/speakers/:id", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf, async (request, response) => {
  if (!/^[a-f0-9-]{36}$/i.test(request.params.id)) return response.status(400).json({ error: "잘못된 화자 ID입니다." });
  const existing = (await speakerStore.list(request.auth.organization.id)).find(({ id }) => id === request.params.id);
  if (!existing) return response.status(404).json({ error: "등록된 목소리를 찾지 못했습니다." });
  if (!existing.createdBy || existing.createdBy !== request.auth.user.id) return response.status(403).json({ error: "본인의 목소리 프로필만 삭제할 수 있습니다." });
  const removed = await speakerStore.removeOwned(request.params.id, request.auth.user.id);
  if (!removed) return response.status(404).json({ error: "등록된 목소리를 찾지 못했습니다." });
  response.status(204).end();
});

app.post("/api/transcribe", requireTrustedOrigin, requireAuth, requireOrganization, requireCsrf,
  transcriptionRateLimit, transcriptionConcurrencyLimit, upload.single("audio"), async (request, response) => {
  if (!process.env.OPENAI_API_KEY) return response.status(503).json({ error: "OPENAI_API_KEY가 설정되지 않았습니다." });
  if (!request.file) return response.status(400).json({ error: "지원되는 오디오 파일이 필요합니다." });

  try {
    const language = typeof request.body?.language === "string" ? request.body.language.trim() : "";
    const transcription = await transcribeAudioFile(request.file, language, request.auth.organization.id);
    await requireDurationAllowance(request.auth.organization.id, transcription.duration);
    return response.json(transcription);
  } catch (error) {
    if (error instanceof BillingError) throw error;
    return transcriptionErrorResponse(error, response);
  }
});

app.use("/api", (_request, response) => {
  response.status(404).json({ error: "API 경로를 찾지 못했습니다." });
});

app.use((error, _request, response, _next) => {
  if (error instanceof MeetingAuthorizationError) {
    return response.status(error.status).json({ error: error.message, code: error.code });
  }
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
  if (error instanceof BillingError || error instanceof TossPaymentsError || error instanceof VoiceProfileError) {
    return response.status(error.status).json({ error: error.message, code: error.code });
  }
  const roomStatus = roomErrorHttpStatus(error);
  if (roomStatus) return response.status(roomStatus).json({ error: error.message, code: error.code });
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return response.status(413).json({ error: "오디오 파일은 25MB 이하여야 합니다." });
  }
  console.error("Request failed:", error);
  return response.status(400).json({ error: "요청을 처리할 수 없습니다." });
});

await Promise.all([
  authStore.initialize(), speakerStore.initialize(), meetingStore.initialize(), roomStore.initialize(),
  voiceProfileStore.initialize(), billingStore.initialize(), requestRateLimiter.initialize()
]);
const server = app.listen(port, () => {
  console.log(`Voice Partition is running at http://localhost:${port}`);
});
// 화자 recognition을 다시 켤 때 모델 사전 로드도 함께 복구한다.
// if (shouldPreloadSpeakerModel) {
//   prepareSpeakerModel()
//     .then(() => console.log(JSON.stringify({ level: "info", event: "speaker_model_ready", model: speakerModelInfo.id })))
//     .catch((error) => console.error(JSON.stringify({ level: "error", event: "speaker_model_failed", message: error.message })));
// }

const liveServer = new WebSocketServer({ noServer: true });
const roomLiveHub = new RoomLiveHub({ termBridgeFactory });

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
  const requestedRoomId = String(requestUrl.searchParams.get("roomId") || "").trim();
  if (requestedRoomId) {
    try {
      if (!process.env.DEEPGRAM_API_KEY) {
        throw new VoiceProfileError("DEEPGRAM_NOT_CONFIGURED", "DEEPGRAM_API_KEY가 필요합니다.", 503);
      }
      const auth = await authStore.getContextBySession(sessionToken(request));
      if (!auth) throw new VoiceProfileError("UNAUTHENTICATED", "로그인이 필요합니다.", 401);
      const room = await requireRoomMember({ roomStore, roomId: requestedRoomId, auth });
      const canonicalProfile = await roomTranscriptProfile(auth);
      const billingAccess = await requireMeetingAllowance(auth.organization.id);
      const meeting = await bindRoomMeeting({
        meetingStore,
        room,
        auth,
        language: requestUrl.searchParams.get("language"),
        requestedMeetingId: requestUrl.searchParams.get("meetingId") || ""
      });
      const hubConnection = await roomLiveHub.acquire({
        roomId: room.id,
        meetingId: meeting.id,
        client,
        meetingTopic: meeting.title || "",
        participant: {
          userId: auth.user.id,
          introduction: auth.user.introduction || "",
          knownTerms: auth.user.vocabulary?.knownTerms || []
        },
        loadPersistedSegments: async () => {
          const persisted = await meetingStore.get(meeting.id, auth.organization.id);
          return persisted?.segments || [];
        },
        loadRoomStatus: async () => (await roomStore.get(room.id, auth.organization.id))?.status || "closed",
        loadPersistedLiveMapState: async () => {
          const persisted = await meetingStore.get(meeting.id, auth.organization.id);
          if (!persisted) return null;
          const intelligence = await meetingStore.getIntelligence(
            persisted.id, auth.organization.id, transcriptHash(persisted.segments)
          );
          return intelligence?.meetMap ? { seq: 0, result: intelligence.meetMap } : null;
        },
        liveMapClient: goLiveMapClient,
        liveMapEnabled: isLiveMapEnabled(),
        tenantKey: `${auth.organization.id}:${room.id}`,
        pollIntervalMs: Number(process.env.LIVEMAP_POLL_INTERVAL_MS) || 1_000,
        log: (entry) => console.log(JSON.stringify({ level: "info", ...entry })),
        persistFinalizedResult: async (liveMapFinal) => {
          if (!liveMapFinal?.result?.topics?.length) return;
          const persisted = await meetingStore.get(meeting.id, auth.organization.id);
          if (!persisted) return;
          const hash = transcriptHash(persisted.segments);
          const existing = await meetingStore.getIntelligence(persisted.id, auth.organization.id, hash);
          const meetMap = { ...liveMapFinal.result, origin: "livemap" };
          await meetingStore.saveIntelligence({
            meetingId: persisted.id,
            organizationId: auth.organization.id,
            transcriptHash: hash,
            source: "livemap",
            model: liveMapFinal.metrics?.model || "livemap",
            result: mergeMeetMapIntelligence(existing, persisted, meetMap)
          });
        }
      });
      await handleSelfOnlyRoomLive({
        client,
        requestUrl,
        auth,
        room,
        meeting,
        canonicalProfile,
        meetingStore,
        prepareSpeakerModel,
        speakerRecognitionEnabled,
        speakerModelInfo,
        speakerInferenceInfo,
        maximumAudioBytes: billingAccess.entitlements.meetingDurationSeconds == null
          ? Number.POSITIVE_INFINITY
          : billingAccess.entitlements.meetingDurationSeconds * speakerModelInfo.sampleRate * 2,
        deepgramApiKey: process.env.DEEPGRAM_API_KEY,
        hubConnection
      });
    } catch (error) {
      const code = error?.code || "ROOM_LIVE_REJECTED";
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "error", code, message: error.message || "방 연결을 시작하지 못했습니다." }));
        client.close(code === "UNAUTHENTICATED" ? 1008 : 1011);
      }
    }
    return;
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    client.send(JSON.stringify({ type: "error", message: "DEEPGRAM_API_KEY가 필요합니다." }));
    return client.close(1011);
  }

  let deepgram;
  let finalizeFallback;
  let providerKeepAlive;
  // LiveMap bridge lives in the connection-function scope so the close handler
  // (registered outside the try below) can always dispose it. Defaults to a
  // no-op so a pre-auth failure never leaves it undefined.
  let liveMapBridge = createNoopLiveMapBridge();
  let termLiveBridge = createNoopTermLiveBridge();
  let liveMapMeetingId = null;
  try {
    const auth = await authStore.getContextBySession(sessionToken(request));
    if (!auth) throw new Error("로그인이 필요합니다.");
    if (!auth.organization) throw new Error("먼저 조직을 만들거나 가입해 주세요.");
    const billingAccess = await requireMeetingAllowance(auth.organization.id);
    // const mode = requestUrl.searchParams.get("mode") === "speaker" ? "speaker" : "stt";
    const mode = "stt";
    const speakers = mode === "speaker" ? await loadCurrentSpeakerProfiles(auth.organization.id) : [];
    if (mode === "speaker" && !speakers.length) throw new Error("화자 식별 모드에는 등록 목소리가 한 명 이상 필요합니다.");
    // Real-time livemap bridge: zero overhead / zero requests when disabled.
    if (isLiveMapEnabled()) {
      liveMapBridge = createLiveMapBridge({
        client: goLiveMapClient,
        send: (payload) => {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
        },
        tenantKey: `${auth.organization.id}:${auth.user.id}`,
        meetingId: null,
        log: (entry) => console.log(JSON.stringify({ level: "info", ...entry })),
        pollIntervalMs: Number(process.env.LIVEMAP_POLL_INTERVAL_MS) || 1_000
      });
    }
    if (termBridgeFactory) {
      // 단독 녹음 경로는 참가자가 녹음자 한 명뿐인 회의방과 같다.
      termLiveBridge = termBridgeFactory({
        meetingTopic: "",
        participants: () => [{
          userId: auth.user.id,
          introduction: auth.user.introduction || "",
          knownTerms: auth.user.vocabulary?.knownTerms || [],
          send: (payload) => {
            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
          }
        }],
        log: (entry) => console.log(JSON.stringify({ level: "info", ...entry }))
      });
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
    const speakerAudioAccumulator = new SpeakerAudioAccumulator({
      sampleRate: speakerModelInfo.sampleRate,
      minimumSeconds: speakerInferenceInfo.windowSeconds
    });

    const analyzeDiarizedRegions = async (words) => {
      for (const region of diarizedAudioRegions(words, { minimumDuration: 0.2 })) {
        const cacheKey = `${region.sourceSpeaker}:${region.start.toFixed(2)}:${region.end.toFixed(2)}`;
        if (analyzedRegions.has(cacheKey)) continue;
        const sampleRange = speakerRegionSampleRange(region, audioHistory, speakerModelInfo.sampleRate);
        if (!sampleRange) continue;
        const snapshot = audioHistory.slice(sampleRange.firstSample, sampleRange.lastSample);
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
          const scores = await speakerModel.compare(accumulated.pcm, profiles, {
            maximumEmbeddings: speakerInferenceInfo.realtimeMaximumEmbeddings
          });
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

    const organizationTerms = await meetingStore.listVocabularyTerms(auth.organization.id, auth.user.vocabulary?.knownTerms || []);
    const keyterms = buildSttKeyterms({
      knownTerms: auth.user.vocabulary?.knownTerms || [],
      organizationTerms,
      speakerNames: speakers.map(({ name }) => name)
    });
    const query = buildDeepgramLiveQuery({
      language: requestUrl.searchParams.get("language"), mode, keyterms
    });
    deepgram = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
    });

    deepgram.on("open", () => {
      providerKeepAlive = createDeepgramKeepAlive(deepgram);
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({
        type: "ready", mode, sampleRate: speakerModelInfo.sampleRate, speakers: speakers.map(({ id, name }) => ({ id, name }))
      }));
    });

    let transcriptQueue = Promise.resolve();
    let forwardedAudioBytes = 0;
    const maximumAudioBytes = billingAccess.entitlements.meetingDurationSeconds == null
      ? Number.POSITIVE_INFINITY
      : billingAccess.entitlements.meetingDurationSeconds * speakerModelInfo.sampleRate * 2;
    let finalizationAcknowledged = false;
    let diarizationWarningSent = false;
    const acknowledgeFinalization = () => {
      if (finalizationAcknowledged) return;
      finalizationAcknowledged = true;
      clearTimeout(finalizeFallback);
      transcriptQueue.finally(async () => {
        // Flush the term bridge (마지막 청크의 용어까지 추출·푸시). Best effort.
        try {
          await termLiveBridge.finalize();
        } catch { /* never block finalization */ }
        // Flush the livemap bridge (posts the last turn, finalizes the Go
        // session). All failure paths return null — never block finalization.
        let liveMapFinal = null;
        try {
          liveMapFinal = await liveMapBridge.finalize();
        } catch {
          liveMapFinal = null;
        }
        try {
          if (liveMapFinal?.result?.topics?.length && liveMapMeetingId) {
            const meetMap = { ...liveMapFinal.result, origin: "livemap" };
            const meeting = await requireMeetingAccess({
              meetingStore,
              roomStore,
              meetingId: liveMapMeetingId,
              auth
            });
            if (meeting) {
              const hash = transcriptHash(meeting.segments);
              const existing = await meetingStore.getIntelligence(meeting.id, auth.organization.id, hash);
              await meetingStore.saveIntelligence({
                meetingId: meeting.id,
                organizationId: auth.organization.id,
                transcriptHash: hash,
                source: "livemap",
                model: liveMapFinal.metrics?.model || "livemap",
                result: mergeMeetMapIntelligence(existing, meeting, meetMap)
              });
            }
          }
        } catch (error) {
          console.error("LiveMap persistence failed:", error);
        }
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "finalized" }));
      });
    };
    deepgram.on("message", (raw) => {
      const parsed = parseDeepgramLiveEvent(raw);
      if (!parsed.ok) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "error",
            message: "실시간 STT 응답이 손상되어 현재까지의 기록을 안전하게 종료합니다."
          }), () => deepgram.readyState === WebSocket.OPEN && deepgram.close(1002, "invalid provider response"));
        } else if (deepgram.readyState === WebSocket.OPEN) {
          deepgram.close(1002, "invalid provider response");
        }
        return;
      }
      const event = parsed.event;
      const providerError = deepgramApplicationError(event);
      if (providerError) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "error", message: providerError.message, code: providerError.code }),
            () => deepgram.readyState === WebSocket.OPEN && deepgram.close(1011, "provider error"));
        } else if (deepgram.readyState === WebSocket.OPEN) {
          deepgram.close(1011, "provider error");
        }
        return;
      }
      if (event.type === "SpeechStarted") {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "speech_started", timestamp: Number(event.timestamp) || 0 }));
        }
        return;
      }
      if (event.type === "UtteranceEnd") {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "utterance_end", lastWordEnd: Number(event.last_word_end) || 0 }));
        }
        return;
      }
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
              threshold: Number(process.env.SPEAKER_MATCH_THRESHOLD) || speakerModelInfo.defaultMatchThreshold,
              margin: Number(process.env.SPEAKER_MATCH_MARGIN) || speakerModelInfo.defaultMatchMargin,
              tracker: identityTracker,
              pendingSpeakerClusters
            })
            : wordsToTranscriptSegments(alternative.words);
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "transcript", isFinal: Boolean(event.is_final), speechFinal: Boolean(event.speech_final), segments }));
          }
          if (event.is_final) {
            for (const segment of segments) {
              liveMapBridge.handleFinalSegment(segment);
              termLiveBridge.handleFinalSegment(segment);
            }
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
      console.error("Deepgram live connection failed:", error);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "error",
          message: "실시간 STT 제공자 연결이 불안정해 현재까지의 기록을 안전하게 종료합니다. 잠시 후 다시 시도해 주세요."
        }));
      }
    });
    deepgram.on("close", () => {
      providerKeepAlive?.stop();
      if (client.readyState === WebSocket.OPEN) client.close(1011, "STT connection closed");
    });

    client.on("message", (data, isBinary) => {
      if (deepgram.readyState !== WebSocket.OPEN) return;
      if (!isBinary) {
        try {
          const control = JSON.parse(data.toString());
          if (control.type === "finalize" && !finalizationAcknowledged) {
            // Optional meetingId lets the livemap tree be persisted at session
            // end; when absent (current client) the REST meeting-save path owns
            // MeetMap persistence and this stays null.
            if (control.meetingId) liveMapMeetingId = String(control.meetingId);
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
      if (forwardedAudioBytes + incoming.length > maximumAudioBytes) {
        const closeProvider = () => {
          if (deepgram.readyState === WebSocket.OPEN) deepgram.close(1000, "plan duration reached");
        };
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "error",
            code: "PLAN_DURATION_LIMIT",
            message: `${billingAccess.entitlements.planId} 플랜의 회의당 최대 녹음 시간에 도달해 현재 기록을 저장합니다.`
          }), closeProvider);
        } else {
          closeProvider();
        }
        return;
      }
      if (!canForwardLiveAudio(deepgram)) {
        const closeProvider = () => {
          if (deepgram.readyState === WebSocket.OPEN) deepgram.close(1011, "audio backpressure");
        };
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "error",
            message: "STT 제공자 전송이 5초 이상 지연되어 현재 기록을 안전하게 종료합니다. 잠시 후 다시 시도해 주세요."
          }), closeProvider);
        } else {
          closeProvider();
        }
        return;
      }
      deepgram.send(incoming);
      forwardedAudioBytes += incoming.length;
      providerKeepAlive?.markAudioForwarded();
      if (mode !== "speaker") return;
      audioHistory.append(incoming);
    });
  } catch (error) {
    console.error("Live session failed:", error);
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({
      type: "error",
      message: error.message,
      ...(error.code ? { code: error.code } : {})
    }));
    client.close(1011);
  }

  client.on("close", () => {
    clearTimeout(finalizeFallback);
    liveMapBridge.dispose();
    termLiveBridge.dispose();
    providerKeepAlive?.stop();
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
