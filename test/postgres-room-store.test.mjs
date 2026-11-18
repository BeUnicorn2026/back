import assert from "node:assert/strict";
import test from "node:test";
import { DataType, newDb } from "pg-mem";
import { PostgresDatabase } from "../lib/postgres-database.mjs";
import { PostgresRoomStore } from "../lib/postgres-room-store.mjs";
import { RoomStoreError } from "../lib/room-store.mjs";

async function fixture(options = {}) {
  const memory = newDb({ autoCreateForeignKeyIndices: true });
  memory.public.registerOperator({
    operator: "~", left: DataType.text, right: DataType.text, returns: DataType.bool,
    implementation: (value, pattern) => new RegExp(pattern).test(value)
  });
  const { Pool } = memory.adapters.createPg();
  const pool = new Pool();
  const database = new PostgresDatabase({ pool });
  await database.query(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    CREATE TABLE memberships (
      user_id TEXT NOT NULL REFERENCES users(id),
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      PRIMARY KEY(user_id, organization_id)
    );
    INSERT INTO users(id) VALUES ('owner-a'), ('member-a'), ('outsider'), ('owner-b');
    INSERT INTO organizations(id) VALUES ('org-a'), ('org-b');
    INSERT INTO memberships(user_id, organization_id) VALUES
      ('owner-a', 'org-a'), ('member-a', 'org-a'), ('owner-b', 'org-b');
  `);
  return { database, pool, store: new PostgresRoomStore(database, options) };
}

function hasCode(code) {
  return (error) => error instanceof RoomStoreError && error.code === code;
}

test("PostgreSQL room store generates a numeric room only for the ROOM command", async () => {
  const { database, pool, store } = await fixture({ roomFactory: () => "1234", accessCodeFactory: () => "VP-0123456789AB" });
  try {
    const room = await store.create({
      organizationId: "org-a", createdBy: "owner-a", command: "ROOM",
      accessCode: "VP-CLIENTVALUE0", idempotencyKey: "create-a"
    });
    assert.match(room.id, /^[0-9a-f-]{36}$/);
    assert.equal(room.room, "1234");
    assert.equal(room.accessCode, "VP-0123456789AB");
    assert.equal((await database.query("SELECT COUNT(*)::integer AS count FROM room_memberships")).rows[0].count, 1);
    await assert.rejects(store.create({
      organizationId: "org-a", createdBy: "owner-a", command: "1234", idempotencyKey: "bad"
    }), hasCode("ROOM_COMMAND_REQUIRED"));
    await assert.rejects(database.query(`INSERT INTO rooms
      (id, room, access_code, organization_id, created_by, status, idempotency_key, created_at, updated_at)
      VALUES ('10000000-0000-4000-8000-000000000001', 'BAD!', 'VP-0123456789AC',
        'org-a', 'owner-a', 'active', 'invalid-direct', 'now', 'now')`));
  } finally {
    await pool.end();
  }
});

test("PostgreSQL room store handles idempotency, concurrency, and distinct collisions", async () => {
  const codes = ["VP-000000000000", "VP-000000000000", "VP-111111111111"];
  const rooms = ["1234", "5678", "9012"];
  const { pool, store } = await fixture({ accessCodeFactory: () => codes.shift(), roomFactory: () => rooms.shift() });
  try {
    const request = { organizationId: "org-a", createdBy: "owner-a", command: "ROOM", idempotencyKey: "same" };
    const [first, replay] = await Promise.all([store.create(request), store.create(request)]);
    assert.equal(replay.id, first.id);
    assert.equal(replay.accessCode, first.accessCode);
    assert.equal(Object.hasOwn(await store.get(first.id, "org-a"), "accessCode"), false);
    assert.equal(Object.hasOwn(await store.getByRoom(first.room, "org-a"), "accessCode"), false);
    assert.equal(Object.hasOwn((await store.listForUser("owner-a", "org-a"))[0], "accessCode"), false);
    const resumed = await store.create({ ...request, idempotencyKey: "different" });
    assert.notEqual(resumed.id, first.id);
    assert.equal(resumed.room, "9012");
    assert.equal(resumed.accessCode, "VP-111111111111");
  } finally {
    await pool.end();
  }

  const exhausted = await fixture({ roomFactory: () => "9999", accessCodeFactory: () => "VP-ZZZZZZZZZZZZ", collisionRetries: 2 });
  try {
    await exhausted.store.create({
      organizationId: "org-a", createdBy: "owner-a", command: "ROOM", idempotencyKey: "one"
    });
    await assert.rejects(exhausted.store.create({
      organizationId: "org-a", createdBy: "owner-a", command: "ROOM", idempotencyKey: "two"
    }), hasCode("ROOM_CODE_EXHAUSTED"));
  } finally {
    await exhausted.pool.end();
  }
});

test("PostgreSQL room join is tenant-isolated and does not grant organization membership", async () => {
  const generatedRooms = ["2468", "1357", "2468"];
  const { database, pool, store } = await fixture({ roomFactory: () => generatedRooms.shift() });
  try {
    const room = await store.create({
      organizationId: "org-a", createdBy: "owner-a", command: "ROOM", idempotencyKey: "join"
    });
    assert.equal(await store.get(room.id, "org-b"), null);
    assert.equal(await store.getByRoom(room.room, "org-b"), null);
    const closedRoom = await store.create({
      organizationId: "org-a", createdBy: "owner-a", command: "ROOM", idempotencyKey: "closed"
    });
    assert.equal((await store.close(closedRoom.id, "org-a", "owner-a")).status, "closed");
    assert.equal((await store.get(closedRoom.id, "org-a")).status, "closed");
    assert.equal((await database.query("SELECT access_code FROM rooms WHERE id = $1", [closedRoom.id])).rows[0].access_code,
      closedRoom.accessCode);
    await assert.rejects(store.join({ organizationId: "org-a", userId: "member-a", room: closedRoom.room }),
      hasCode("ROOM_CLOSED"));
    await assert.rejects(store.join({ organizationId: "org-a", userId: "outsider", accessCode: room.accessCode }),
      hasCode("ORGANIZATION_MEMBERSHIP_REQUIRED"));
    assert.equal((await database.query("SELECT COUNT(*)::integer AS count FROM memberships")).rows[0].count, 3);
    const joined = await store.join({ organizationId: "org-a", userId: "member-a", room: room.room });
    assert.equal(joined.id, room.id);
    assert.equal(Object.hasOwn(joined, "accessCode"), false);
    await assert.rejects(store.join({ organizationId: "org-a", userId: "member-a", room: room.room }),
      hasCode("ALREADY_JOINED"));
    await store.close(room.id, "org-a", "owner-a");
    assert.notEqual((await store.create({
      organizationId: "org-a", createdBy: "owner-a", command: "ROOM", idempotencyKey: "reuse"
    })).id, room.id);
  } finally {
    await pool.end();
  }
});
