export class MeetingAuthorizationError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "MeetingAuthorizationError";
    this.code = code;
    this.status = status;
  }
}

function activeIdentity(auth) {
  const organizationId = String(auth?.organization?.id || "");
  const userId = String(auth?.user?.id || "");
  if (!organizationId || !userId || !auth?.membership) {
    throw new MeetingAuthorizationError(
      "MEETING_ORGANIZATION_REQUIRED",
      "현재 조직의 구성원만 회의에 접근할 수 있습니다.",
      403
    );
  }
  return { organizationId, userId };
}

export async function requireMeetingAccess({ meetingStore, roomStore, meetingId, auth }) {
  const { organizationId, userId } = activeIdentity(auth);
  const meeting = await meetingStore.get(String(meetingId || ""), organizationId);
  if (!meeting) {
    throw new MeetingAuthorizationError("MEETING_NOT_FOUND", "회의 문서를 찾지 못했습니다.", 404);
  }
  if (meeting.roomId && !await roomStore.isMember(meeting.roomId, userId, organizationId)) {
    throw new MeetingAuthorizationError("ROOM_MEETING_FORBIDDEN", "방 구성원만 이 회의에 접근할 수 있습니다.", 403);
  }
  return meeting;
}

export async function filterMeetingsForAccess({ meetings, roomStore, auth }) {
  const { organizationId, userId } = activeIdentity(auth);
  const allowed = await Promise.all((Array.isArray(meetings) ? meetings : []).map(async (meeting) => (
    !meeting?.roomId || await roomStore.isMember(meeting.roomId, userId, organizationId)
  )));
  return meetings.filter((_meeting, index) => allowed[index]);
}
