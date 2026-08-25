import assert from "node:assert/strict";
import test from "node:test";
import {
  filterMeetingsForAccess,
  MeetingAuthorizationError,
  requireMeetingAccess
} from "../lib/meeting-authorization.mjs";

const auth = {
  user: { id: "user-a" },
  organization: { id: "org-a" },
  membership: { role: "member" }
};

function stores({ member = false, meeting = { id: "meeting-a", organizationId: "org-a", roomId: "room-a" } } = {}) {
  return {
    meetingStore: {
      async get(id, organizationId) {
        return id === meeting?.id && organizationId === meeting?.organizationId ? meeting : null;
      }
    },
    roomStore: {
      async isMember(roomId, userId, organizationId) {
        return member && roomId === "room-a" && userId === "user-a" && organizationId === "org-a";
      }
    }
  };
}

test("legacy meetings retain organization-level access", async () => {
  const legacy = { id: "legacy", organizationId: "org-a", roomId: null };
  const { meetingStore, roomStore } = stores({ meeting: legacy });
  assert.equal((await requireMeetingAccess({ meetingStore, roomStore, meetingId: legacy.id, auth })).id, "legacy");
});

test("room-bound meetings require active-organization room membership", async () => {
  const denied = stores();
  await assert.rejects(
    requireMeetingAccess({ ...denied, meetingId: "meeting-a", auth }),
    (error) => error instanceof MeetingAuthorizationError
      && error.code === "ROOM_MEETING_FORBIDDEN"
      && error.status === 403
  );

  const allowed = stores({ member: true });
  assert.equal((await requireMeetingAccess({ ...allowed, meetingId: "meeting-a", auth })).id, "meeting-a");
  await assert.rejects(
    requireMeetingAccess({ ...allowed, meetingId: "meeting-a", auth: { ...auth, organization: { id: "org-b" } } }),
    (error) => error.code === "MEETING_NOT_FOUND" && error.status === 404
  );
});

test("meeting lists omit room meetings for rooms the user has not joined", async () => {
  const meetings = [
    { id: "legacy", roomId: null },
    { id: "joined", roomId: "room-a" },
    { id: "private", roomId: "room-b" }
  ];
  const roomStore = {
    async isMember(roomId, userId, organizationId) {
      return roomId === "room-a" && userId === "user-a" && organizationId === "org-a";
    }
  };
  assert.deepEqual(
    (await filterMeetingsForAccess({ meetings, roomStore, auth })).map(({ id }) => id),
    ["legacy", "joined"]
  );
});
