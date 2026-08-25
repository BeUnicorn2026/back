import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { openSqliteDatabase, runTransaction } from "./sqlite-database.mjs";

const ROOM_PATTERN = /^[A-Z0-9]{4}$/;
const ACCESS_CODE_PATTERN = /^VP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEFAULT_COLLISION_RETRIES = 8;

export class RoomStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoomStoreError";
    this.code = code;
  }
}

export function generateRoomAccessCode() {
  const bytes = randomBytes(12);
  let suffix = "";
  for (const byte of bytes) suffix += CROCKFORD_ALPHABET[byte & 31];
  return `VP-${suffix}`;
}

export function normalizeRoomCreateInput({ organizationId, createdBy, room, idempotencyKey } = {}) {
  const normalized = {
    organizationId: String(organizationId || "").trim(),
    createdBy: String(createdBy || "").trim(),
    room: String(room || ""),
    idempotencyKey: String(idempotencyKey || "").trim()
  };
  if (!normalized.organizationId || !normalized.createdBy) {
    throw new RoomStoreError("ROOM_OWNER_REQUIRED", "방의 조직과 생성자가 필요합니다.");
  }
  if (!ROOM_PATTERN.test(normalized.room)) {
    throw new RoomStoreError("INVALID_ROOM", "방 코드는 정확히 4자의 영문 대문자 또는 숫자여야 합니다.");
  }
  if (!normalized.idempotencyKey || normalized.idempotencyKey.length > 200) {
    throw new RoomStoreError("IDEMPOTENCY_KEY_INVALID", "유효한 멱등성 키가 필요합니다.");
  }
  return normalized;
}

export function roomFromRow(row, { includeAccessCode = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    room: row.room,
    ...(includeAccessCode ? { accessCode: row.access_code } : {}),
    organizationId: row.organization_id,
    createdBy: row.created_by,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at
  };
}

function validateGeneratedAccessCode(accessCode) {
  if (!ACCESS_CODE_PATTERN.test(accessCode)) {
    throw new RoomStoreError("ACCESS_CODE_GENERATOR_INVALID", "생성된 방 접근 코드 형식이 올바르지 않습니다.");
  }
}

export class RoomStore {
  constructor(rootDirectory, options = {}) {
    this.databasePath = options.databasePath || path.join(rootDirectory, "rooms.sqlite");
    this.uuidFactory = options.uuidFactory || randomUUID;
    this.accessCodeFactory = options.accessCodeFactory || generateRoomAccessCode;
    this.collisionRetries = Math.max(1, Number(options.collisionRetries) || DEFAULT_COLLISION_RETRIES);
    this.database = null;
    this.initializing = null;
  }

  async initialize() {
    if (!this.initializing) this.initializing = this.#initialize();
    return this.initializing;
  }

  async #initialize() {
    this.database = await openSqliteDatabase(this.databasePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY CHECK(
          length(id) = 36 AND substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-'
          AND substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-'
          AND id NOT GLOB '*[^0-9a-f-]*'
        ),
        room TEXT NOT NULL CHECK(length(room) = 4 AND room NOT GLOB '*[^A-Z0-9]*'),
        access_code TEXT NOT NULL CHECK(
          length(access_code) = 15 AND substr(access_code, 1, 3) = 'VP-'
          AND substr(access_code, 4) NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
        ),
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        created_by TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL CHECK(status IN ('active', 'closed')),
        idempotency_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        CHECK(room <> access_code),
        CHECK((status = 'active' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL)),
        UNIQUE(id, organization_id),
        UNIQUE(organization_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS room_memberships (
        room_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('creator', 'member')),
        joined_at TEXT NOT NULL,
        PRIMARY KEY(room_id, user_id),
        FOREIGN KEY(room_id, organization_id) REFERENCES rooms(id, organization_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS rooms_active_organization_room_idx
        ON rooms(organization_id, room) WHERE status = 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS rooms_active_access_code_idx
        ON rooms(access_code) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS room_memberships_user_organization_idx
        ON room_memberships(user_id, organization_id);
    `);
  }

  async #ready() {
    await this.initialize();
    return this.database;
  }

  #assertOrganizationMember(organizationId, userId) {
    const membership = this.database.prepare(
      "SELECT 1 FROM memberships WHERE organization_id = ? AND user_id = ?"
    ).get(organizationId, userId);
    if (!membership) throw new RoomStoreError("ORGANIZATION_MEMBERSHIP_REQUIRED", "조직 구성원만 방에 참여할 수 있습니다.");
  }

  #byId(id, organizationId) {
    return roomFromRow(this.database.prepare(
      "SELECT * FROM rooms WHERE id = ? AND organization_id = ?"
    ).get(id, organizationId));
  }

  async create(input) {
    const { organizationId, createdBy, room, idempotencyKey } = normalizeRoomCreateInput(input);
    const database = await this.#ready();
    return runTransaction(database, () => {
      this.#assertOrganizationMember(organizationId, createdBy);
      const duplicate = database.prepare(
        "SELECT * FROM rooms WHERE organization_id = ? AND idempotency_key = ?"
      ).get(organizationId, idempotencyKey);
      if (duplicate) return roomFromRow(duplicate, { includeAccessCode: true });

      const occupied = database.prepare(
        "SELECT 1 FROM rooms WHERE organization_id = ? AND room = ? AND status = 'active'"
      ).get(organizationId, room);
      if (occupied) throw new RoomStoreError("ROOM_EXISTS", "이 조직에서 사용 중인 방 코드입니다.");

      for (let attempt = 0; attempt < this.collisionRetries; attempt += 1) {
        const accessCode = String(this.accessCodeFactory());
        validateGeneratedAccessCode(accessCode);
        const id = String(this.uuidFactory());
        const now = new Date().toISOString();
        const result = database.prepare(`INSERT OR IGNORE INTO rooms
          (id, room, access_code, organization_id, created_by, status, idempotency_key, created_at, updated_at, closed_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`)
          .run(id, room, accessCode, organizationId, createdBy, idempotencyKey, now, now);
        if (result.changes) {
          database.prepare(`INSERT INTO room_memberships
            (room_id, organization_id, user_id, role, joined_at) VALUES (?, ?, ?, 'creator', ?)`)
            .run(id, organizationId, createdBy, now);
          return roomFromRow(database.prepare("SELECT * FROM rooms WHERE id = ? AND organization_id = ?")
            .get(id, organizationId), { includeAccessCode: true });
        }

        const idempotent = database.prepare(
          "SELECT * FROM rooms WHERE organization_id = ? AND idempotency_key = ?"
        ).get(organizationId, idempotencyKey);
        if (idempotent) return roomFromRow(idempotent, { includeAccessCode: true });
        if (database.prepare(
          "SELECT 1 FROM rooms WHERE organization_id = ? AND room = ? AND status = 'active'"
        ).get(organizationId, room)) {
          throw new RoomStoreError("ROOM_EXISTS", "이 조직에서 사용 중인 방 코드입니다.");
        }
      }
      throw new RoomStoreError("ACCESS_CODE_EXHAUSTED", "고유한 방 접근 코드를 생성하지 못했습니다.");
    });
  }

  async get(id, organizationId) {
    await this.#ready();
    return this.#byId(String(id || ""), String(organizationId || ""));
  }

  async getByRoom(room, organizationId) {
    const database = await this.#ready();
    return roomFromRow(database.prepare(`SELECT * FROM rooms
      WHERE room = ? AND organization_id = ? AND status = 'active'`)
      .get(String(room || ""), String(organizationId || "")));
  }

  async join({ organizationId, userId, accessCode } = {}) {
    const normalizedOrganizationId = String(organizationId || "").trim();
    const normalizedUserId = String(userId || "").trim();
    const normalizedAccessCode = String(accessCode || "");
    const database = await this.#ready();
    return runTransaction(database, () => {
      this.#assertOrganizationMember(normalizedOrganizationId, normalizedUserId);
      const row = database.prepare(`SELECT * FROM rooms
        WHERE organization_id = ? AND access_code = ? AND status = 'active' LIMIT 1`)
        .get(normalizedOrganizationId, normalizedAccessCode);
      if (!row) {
        const closed = database.prepare(`SELECT 1 FROM rooms
          WHERE organization_id = ? AND access_code = ? AND status = 'closed' LIMIT 1`)
          .get(normalizedOrganizationId, normalizedAccessCode);
        if (closed) throw new RoomStoreError("ROOM_CLOSED", "종료된 방에는 참여할 수 없습니다.");
        throw new RoomStoreError("ROOM_NOT_FOUND", "참여할 방을 찾을 수 없습니다.");
      }
      if (database.prepare("SELECT 1 FROM room_memberships WHERE room_id = ? AND user_id = ?")
        .get(row.id, normalizedUserId)) {
        throw new RoomStoreError("ALREADY_JOINED", "이미 참여한 방입니다.");
      }
      database.prepare(`INSERT INTO room_memberships
        (room_id, organization_id, user_id, role, joined_at) VALUES (?, ?, ?, 'member', ?)`)
        .run(row.id, normalizedOrganizationId, normalizedUserId, new Date().toISOString());
      return roomFromRow(row);
    });
  }

  async getMember(roomId, userId, organizationId) {
    const database = await this.#ready();
    const row = database.prepare(`SELECT role, joined_at FROM room_memberships
      WHERE room_id = ? AND user_id = ? AND organization_id = ?`)
      .get(String(roomId || ""), String(userId || ""), String(organizationId || ""));
    return row ? { roomId, userId, organizationId, role: row.role, joinedAt: row.joined_at } : null;
  }

  async isMember(roomId, userId, organizationId) {
    return Boolean(await this.getMember(roomId, userId, organizationId));
  }

  async listForUser(userId, organizationId) {
    const database = await this.#ready();
    return database.prepare(`SELECT r.* FROM rooms r
      JOIN room_memberships rm ON rm.room_id = r.id AND rm.organization_id = r.organization_id
      WHERE rm.user_id = ? AND r.organization_id = ? ORDER BY r.created_at DESC`)
      .all(String(userId || ""), String(organizationId || "")).map((row) => roomFromRow(row));
  }

  async close(id, organizationId, userId) {
    const database = await this.#ready();
    return runTransaction(database, () => {
      const current = this.#byId(String(id || ""), String(organizationId || ""));
      if (!current) throw new RoomStoreError("ROOM_NOT_FOUND", "종료할 방을 찾을 수 없습니다.");
      if (!userId || current.createdBy !== String(userId)) {
        throw new RoomStoreError("ROOM_FORBIDDEN", "방 생성자만 방을 종료할 수 있습니다.");
      }
      const now = new Date().toISOString();
      const hasMeetings = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meetings'").get();
      if (hasMeetings) {
        database.prepare(`UPDATE meetings SET status = 'completed',
          duration = MAX(duration, COALESCE((SELECT MAX(end) FROM meeting_segments WHERE meeting_id = meetings.id), 0)),
          ended_at = COALESCE(ended_at, ?), updated_at = ?
          WHERE organization_id = ? AND room_id = ? AND status = 'recording'`)
          .run(now, now, organizationId, id);
      }
      if (current.status === "closed") return current;
      database.prepare(`UPDATE rooms SET status = 'closed', closed_at = ?, updated_at = ?
        WHERE id = ? AND organization_id = ? AND status = 'active'`)
        .run(now, now, id, organizationId);
      return this.#byId(id, organizationId);
    });
  }
}
