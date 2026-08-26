import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthStore } from "../lib/auth-store.mjs";
import { RoomStore, RoomStoreError } from "../lib/room-store.mjs";

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "voice-partition-rooms-"));
  const databasePath = path.join(root, "app.sqlite");
  const auth = new AuthStore(path.join(root, "auth"), {
    databasePath, verificationSecret: "room-store-test-secret"
  });
  const owner = await auth.signup({ name: "owner", email: `${crypto.randomUUID()}@test.dev`, password: "password-1234", introduction: "Room store test user" });
  const organization = (await auth.createOrganization(owner.id, { name: "Test organization" })).organization;
  const member = await auth.signup({ name: "member", email: `${crypto.randomUUID()}@test.dev`, password: "password-1234", introduction: "Room store test user" });
  await auth.joinOrganization(member.id, organization.inviteCode);
  const outsider = await auth.signup({ name: "outsider", email: `${crypto.randomUUID()}@test.dev`, password: "password-1234", introduction: "Room store test user" });
  return {
    auth, owner, member, outsider, organization,
    store: new RoomStore(root, { databasePath, ...options })
  };
}

function hasCode(code) {
  return (error) => error instanceof RoomStoreError && error.code === code;
}

test("SQLite room store generates a numeric room only for the ROOM command", async () => {
  let factoryCalls = 0;
  const { store, owner, organization } = await fixture({
    roomFactory: () => "1234",
    accessCodeFactory: () => {
      factoryCalls += 1;
      return "VP-0123456789AB";
    }
  });
  const room = await store.create({
    organizationId: organization.id, createdBy: owner.id, command: "ROOM",
    accessCode: "VP-CLIENTVALUE0", idempotencyKey: "request-1"
  });
  assert.match(room.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(room.room, "1234");
  assert.equal(room.accessCode, "VP-0123456789AB");
  assert.notEqual(room.room, room.accessCode);
  assert.equal(factoryCalls, 1);
  assert.deepEqual((await store.listForUser(owner.id, organization.id)).map(({ id }) => id), [room.id]);

  for (const value of ["room ", "CREATE", "1234", ""] ) {
    await assert.rejects(store.create({
      organizationId: organization.id, createdBy: owner.id, command: value, idempotencyKey: `invalid-${value}`
    }), hasCode("ROOM_COMMAND_REQUIRED"));
  }
});

test("SQLite room create is idempotent and distinguishes room and access-code collisions", async () => {
  const codes = ["VP-000000000000", "VP-000000000000", "VP-111111111111"];
  const rooms = ["1234", "5678", "9012"];
  const { store, owner, organization } = await fixture({ accessCodeFactory: () => codes.shift(), roomFactory: () => rooms.shift() });
  const firstInput = { organizationId: organization.id, createdBy: owner.id, command: "ROOM", idempotencyKey: "same" };
  const first = await store.create(firstInput);
  const replay = await store.create({ ...firstInput, accessCode: "VP-CLIENTVALUE0" });
  assert.equal(replay.id, first.id);
  assert.equal(replay.accessCode, first.accessCode);

  const fetched = await store.get(first.id, organization.id);
  assert.equal(Object.hasOwn(fetched, "accessCode"), false);
  assert.equal(Object.hasOwn(await store.getByRoom(first.room, organization.id), "accessCode"), false);
  assert.equal(Object.hasOwn((await store.listForUser(owner.id, organization.id))[0], "accessCode"), false);

  const resumed = await store.create({
    organizationId: organization.id, createdBy: owner.id, command: "ROOM", idempotencyKey: "other"
  });
  assert.notEqual(resumed.id, first.id);
  assert.equal(resumed.room, "9012");
  assert.equal(resumed.accessCode, "VP-111111111111");

  const exhausted = await fixture({ accessCodeFactory: () => "VP-000000000000", roomFactory: () => "9999", collisionRetries: 2 });
  await exhausted.store.create({
    organizationId: exhausted.organization.id, createdBy: exhausted.owner.id, command: "ROOM", idempotencyKey: "one"
  });
  await assert.rejects(exhausted.store.create({
    organizationId: exhausted.organization.id, createdBy: exhausted.owner.id, command: "ROOM", idempotencyKey: "two"
  }), hasCode("ROOM_CODE_EXHAUSTED"));
});

test("SQLite room joins are organization-isolated and never grant organization membership", async () => {
  const generatedRooms = ["2468", "1357", "2468"];
  const { auth, store, owner, member, outsider, organization } = await fixture({ roomFactory: () => generatedRooms.shift() });
  const room = await store.create({
    organizationId: organization.id, createdBy: owner.id, command: "ROOM", idempotencyKey: "joinable"
  });
  assert.equal(await store.get(room.id, "another-org"), null);
  assert.equal(await store.getByRoom(room.room, "another-org"), null);
  await assert.rejects(store.join({
    organizationId: organization.id, userId: outsider.id, accessCode: room.accessCode
  }), hasCode("ORGANIZATION_MEMBERSHIP_REQUIRED"));
  assert.equal((await auth.listMembers(owner.id, organization.id)).length, 2);

  const joined = await store.join({
    organizationId: organization.id, userId: member.id, room: room.room
  });
  assert.equal(joined.id, room.id);
  assert.equal(Object.hasOwn(joined, "accessCode"), false);
  await assert.rejects(store.join({
    organizationId: organization.id, userId: member.id, room: room.room
  }), hasCode("ALREADY_JOINED"));
  await assert.rejects(store.join({
    organizationId: organization.id, userId: member.id, accessCode: "VP-ZZZZZZZZZZZZ"
  }), hasCode("ROOM_NOT_FOUND"));

  const closeOnly = await store.create({
    organizationId: organization.id, createdBy: owner.id, command: "ROOM", idempotencyKey: "close-only"
  });
  await store.close(closeOnly.id, organization.id, owner.id);
  await assert.rejects(store.join({
    organizationId: organization.id, userId: member.id, room: closeOnly.room
  }), hasCode("ROOM_CLOSED"));
  const closed = await store.close(room.id, organization.id, owner.id);
  assert.equal(closed.status, "closed");
  assert.equal(Object.hasOwn(closed, "accessCode"), false);
  const reused = await store.create({
    organizationId: organization.id, createdBy: owner.id, command: "ROOM", idempotencyKey: "reuse"
  });
  assert.notEqual(reused.id, room.id);
});
