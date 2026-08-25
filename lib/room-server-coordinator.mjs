import { randomUUID } from "node:crypto";
import { RoomStoreError } from "./room-store.mjs";

const ROOM_ERROR_HTTP = Object.freeze({
  INVALID_ROOM: 400,
  IDEMPOTENCY_KEY_INVALID: 400,
  ROOM_OWNER_REQUIRED: 400,
  ACCESS_CODE_GENERATOR_INVALID: 500,
  ACCESS_CODE_EXHAUSTED: 503,
  ORGANIZATION_MEMBERSHIP_REQUIRED: 403,
  ROOM_FORBIDDEN: 403,
  ROOM_NOT_FOUND: 404,
  ROOM_CLOSED: 410,
  ROOM_EXISTS: 409,
  ALREADY_JOINED: 409
});

export function roomErrorHttpStatus(error) {
  return error instanceof RoomStoreError ? (ROOM_ERROR_HTTP[error.code] || 400) : null;
}

export function publicRoom(room, { includeAccessCode = false } = {}) {
  if (!room) return null;
  const { accessCode, ...safe } = room;
  return includeAccessCode && accessCode !== undefined ? { ...safe, accessCode } : safe;
}

export class VoiceProfileError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.name = "VoiceProfileError";
    this.code = code;
    this.status = status;
  }
}

export async function resolveCanonicalVoice({ voiceProfileStore, speakerStore, auth, markInvalid = true }) {
  const userId = String(auth?.user?.id || "");
  const organizationId = String(auth?.organization?.id || "");
  if (!userId || !organizationId || !auth?.membership) {
    throw new VoiceProfileError("ORGANIZATION_MEMBERSHIP_REQUIRED", "현재 조직의 구성원만 목소리 프로필을 사용할 수 있습니다.", 403);
  }
  const pointer = await voiceProfileStore.getByUserId(userId);
  if (!pointer) return { state: "missing", profile: null, pointer: null };
  if (pointer.state !== "ready") return { state: "invalid", profile: null, pointer };

  let profile = null;
  try {
    profile = await speakerStore.loadOwnedProfile(pointer.speakerProfileId, userId);
  } catch {
    profile = null;
  }
  if (!profile || profile.id !== pointer.speakerProfileId || profile.createdBy !== userId) {
    if (markInvalid) {
      await voiceProfileStore.markInvalid({ userId, expectedVersion: pointer.version }).catch(() => undefined);
    }
    return { state: "invalid", profile: null, pointer };
  }
  return {
    state: "ready",
    pointer,
    profile: {
      ...profile,
      userId,
      speakerProfileId: profile.id,
      displayName: auth.user.name
    }
  };
}

export async function requireCanonicalVoice(dependencies) {
  const resolved = await resolveCanonicalVoice(dependencies);
  if (resolved.state !== "ready") {
    throw new VoiceProfileError(
      resolved.state === "missing" ? "VOICE_PROFILE_MISSING" : "VOICE_PROFILE_INVALID",
      resolved.state === "missing" ? "먼저 본인 목소리를 등록해 주세요." : "목소리 프로필이 유효하지 않습니다. 다시 등록해 주세요."
    );
  }
  return resolved;
}

export function validateSelfEnrollmentRequest(body = {}) {
  const forbidden = ["name", "displayName", "userId", "createdBy", "organizationId", "ownerId"];
  const present = forbidden.find((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (present) throw new VoiceProfileError("VOICE_OWNERSHIP_CLIENT_FIELD", "목소리 소유자 정보는 서버의 로그인 정보로만 결정됩니다.", 400);
}

export async function publishSelfEnrollment({
  voiceProfileStore,
  speakerStore,
  auth,
  profileBuffer,
  referenceAudio,
  metadata = {},
  idFactory = randomUUID
}) {
  const userId = String(auth?.user?.id || "");
  const organizationId = String(auth?.organization?.id || "");
  if (!userId || !organizationId || !auth?.membership) {
    throw new VoiceProfileError("ORGANIZATION_MEMBERSHIP_REQUIRED", "현재 조직의 구성원만 목소리를 등록할 수 있습니다.", 403);
  }

  const previous = await voiceProfileStore.getByUserId(userId);
  const speakerProfileId = idFactory();
  const staged = {
    ...metadata,
    id: speakerProfileId,
    name: auth.user.name,
    organizationId,
    createdBy: userId,
    createdAt: new Date().toISOString()
  };
  await speakerStore.save(staged, profileBuffer, referenceAudio);

  let published;
  try {
    published = previous
      ? await voiceProfileStore.replace({
        userId,
        speakerProfileId,
        enrollmentOrganizationId: organizationId,
        expectedVersion: previous.version,
        state: "ready"
      })
      : await voiceProfileStore.publishInitial({
        userId,
        speakerProfileId,
        enrollmentOrganizationId: organizationId,
        state: "ready"
      });
  } catch (error) {
    await speakerStore.removeOwned(speakerProfileId, userId).catch(() => undefined);
    throw error;
  }

  if (!new Set(["published", "replaced"]).has(published.status)) {
    await speakerStore.removeOwned(speakerProfileId, userId).catch(() => undefined);
    throw new VoiceProfileError("VOICE_PROFILE_CONFLICT", "다른 등록 요청이 먼저 완료되었습니다. 현재 상태를 새로고침해 주세요.", 409);
  }
  if (previous?.speakerProfileId && previous.speakerProfileId !== speakerProfileId) {
    await speakerStore.removeOwned(previous.speakerProfileId, userId).catch(() => undefined);
  }
  return { pointer: published.profile, speaker: staged };
}

export async function requireRoomMember({ roomStore, roomId, auth, requireActive = true }) {
  const organizationId = String(auth?.organization?.id || "");
  const userId = String(auth?.user?.id || "");
  if (!organizationId || !userId || !auth?.membership) {
    throw new RoomStoreError("ORGANIZATION_MEMBERSHIP_REQUIRED", "현재 조직의 구성원만 방을 사용할 수 있습니다.");
  }
  const room = await roomStore.get(roomId, organizationId);
  if (!room) throw new RoomStoreError("ROOM_NOT_FOUND", "방을 찾을 수 없습니다.");
  if (requireActive && room.status !== "active") throw new RoomStoreError("ROOM_CLOSED", "종료된 방입니다.");
  if (!await roomStore.isMember(room.id, userId, organizationId)) {
    throw new RoomStoreError("ROOM_FORBIDDEN", "방 구성원만 접근할 수 있습니다.");
  }
  return room;
}

export async function bindRoomMeeting({ meetingStore, room, auth, language = "ko", requestedMeetingId = "" }) {
  const meeting = await meetingStore.bindRoomMeeting({
    organizationId: auth.organization.id,
    createdBy: auth.user.id,
    roomId: room.id,
    language,
    title: room.room,
    requestedMeetingId: requestedMeetingId ? String(requestedMeetingId) : ""
  });
  if (meeting) return meeting;
  if (requestedMeetingId) {
    throw new VoiceProfileError("ROOM_MEETING_MISMATCH", "이 방에 연결된 진행 중 회의가 아닙니다.", 403);
  }
  throw new RoomStoreError("ROOM_CLOSED", "종료된 방입니다.");
}
