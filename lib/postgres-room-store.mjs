import { randomUUID } from "node:crypto";
import {
  generateRoomAccessCode,
  normalizeRoomCreateInput,
  roomFromRow,
  RoomStoreError
} from "./room-store.mjs";

const ACCESS_CODE_PATTERN = /^VP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
const DEFAULT_COLLISION_RETRIES = 8;

function validateGeneratedAccessCode(accessCode) {
  if (!ACCESS_CODE_PATTERN.test(accessCode)) {
    throw new RoomStoreError("ACCESS_CODE_GENERATOR_INVALID", "생성된 방 접근 코드 형식이 올바르지 않습니다.");
  }
}

export class PostgresRoomStore {
  constructor(database, options = {}) {
    this.database = database;
    this.uuidFactory = options.uuidFactory || randomUUID;
    this.accessCodeFactory = options.accessCodeFactory || generateRoomAccessCode;
    this.collisionRetries = Math.max(1, Number(options.collisionRetries) || DEFAULT_COLLISION_RETRIES);
    this.initializing = null;
  }

  async initialize() {
    if (!this.initializing) this.initializing = this.#initialize();
    return this.initializing;
  }

  async #initialize() {
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id UUID PRIMARY KEY,
        room TEXT NOT NULL CHECK(room ~ '^[A-Z0-9]{4}$'),
        access_code TEXT NOT NULL CHECK(access_code ~ '^VP-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$'),
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
        room_id UUID NOT NULL,
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

  async #assertOrganizationMember(queryable, organizationId, userId) {
    const membership = await queryable.query(
      "SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2",
      [organizationId, userId]
    );
    if (!membership.rows.length) {
      throw new RoomStoreError("ORGANIZATION_MEMBERSHIP_REQUIRED", "조직 구성원만 방에 참여할 수 있습니다.");
    }
  }

  async #byId(queryable, id, organizationId) {
    const result = await queryable.query(
      "SELECT * FROM rooms WHERE id = $1 AND organization_id = $2", [id, organizationId]
    );
    return roomFromRow(result.rows[0]);
  }

  async create(input) {
    const { organizationId, createdBy, room, idempotencyKey } = normalizeRoomCreateInput(input);
    await this.initialize();
    return this.database.transaction(async (client) => {
      await this.#assertOrganizationMember(client, organizationId, createdBy);
      const duplicate = (await client.query(
        "SELECT * FROM rooms WHERE organization_id = $1 AND idempotency_key = $2",
        [organizationId, idempotencyKey]
      )).rows[0];
      if (duplicate) return roomFromRow(duplicate, { includeAccessCode: true });

      const occupied = await client.query(
        "SELECT * FROM rooms WHERE organization_id = $1 AND room = $2 AND status = 'active'",
        [organizationId, room]
      );
      if (occupied.rows[0]?.created_by === createdBy) {
        return roomFromRow(occupied.rows[0], { includeAccessCode: true });
      }
      if (occupied.rowCount) throw new RoomStoreError("ROOM_EXISTS", "이 조직에서 사용 중인 방 코드입니다.");

      for (let attempt = 0; attempt < this.collisionRetries; attempt += 1) {
        const accessCode = String(this.accessCodeFactory());
        validateGeneratedAccessCode(accessCode);
        const id = String(this.uuidFactory());
        const now = new Date().toISOString();
        const inserted = await client.query(`INSERT INTO rooms
          (id, room, access_code, organization_id, created_by, status, idempotency_key, created_at, updated_at, closed_at)
          VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7, NULL)
          ON CONFLICT DO NOTHING RETURNING *`,
        [id, room, accessCode, organizationId, createdBy, idempotencyKey, now]);
        if (inserted.rowCount) {
          await client.query(`INSERT INTO room_memberships
            (room_id, organization_id, user_id, role, joined_at) VALUES ($1, $2, $3, 'creator', $4)`,
          [id, organizationId, createdBy, now]);
          return roomFromRow(inserted.rows[0], { includeAccessCode: true });
        }

        const idempotent = (await client.query(
          "SELECT * FROM rooms WHERE organization_id = $1 AND idempotency_key = $2",
          [organizationId, idempotencyKey]
        )).rows[0];
        if (idempotent) return roomFromRow(idempotent, { includeAccessCode: true });
        const roomTaken = await client.query(
          "SELECT * FROM rooms WHERE organization_id = $1 AND room = $2 AND status = 'active'",
          [organizationId, room]
        );
        if (roomTaken.rows[0]?.created_by === createdBy) {
          return roomFromRow(roomTaken.rows[0], { includeAccessCode: true });
        }
        if (roomTaken.rowCount) throw new RoomStoreError("ROOM_EXISTS", "이 조직에서 사용 중인 방 코드입니다.");
      }
      throw new RoomStoreError("ACCESS_CODE_EXHAUSTED", "고유한 방 접근 코드를 생성하지 못했습니다.");
    });
  }

  async get(id, organizationId) {
    await this.initialize();
    return this.#byId(this.database, String(id || ""), String(organizationId || ""));
  }

  async getByRoom(room, organizationId) {
    await this.initialize();
    const result = await this.database.query(`SELECT * FROM rooms
      WHERE room = $1 AND organization_id = $2 AND status = 'active'`,
    [String(room || ""), String(organizationId || "")]);
    return roomFromRow(result.rows[0]);
  }

  async join({ organizationId, userId, accessCode } = {}) {
    const normalizedOrganizationId = String(organizationId || "").trim();
    const normalizedUserId = String(userId || "").trim();
    const normalizedAccessCode = String(accessCode || "");
    await this.initialize();
    return this.database.transaction(async (client) => {
      await this.#assertOrganizationMember(client, normalizedOrganizationId, normalizedUserId);
      const row = (await client.query(`SELECT * FROM rooms
        WHERE organization_id = $1 AND access_code = $2 AND status = 'active' LIMIT 1`,
      [normalizedOrganizationId, normalizedAccessCode])).rows[0];
      if (!row) {
        // pg-mem can incorrectly reuse the partial active-code index for an
        // equality lookup that also asks for closed history. Keep the normal
        // join path indexable, then inspect only this tenant's closed rows.
        const closedCandidates = (await client.query(`SELECT access_code FROM rooms
          WHERE organization_id = $1 AND status = 'closed'`,
        [normalizedOrganizationId])).rows;
        if (closedCandidates.some(({ access_code }) => access_code === normalizedAccessCode)) {
          throw new RoomStoreError("ROOM_CLOSED", "종료된 방에는 참여할 수 없습니다.");
        }
        throw new RoomStoreError("ROOM_NOT_FOUND", "참여할 방을 찾을 수 없습니다.");
      }
      const membership = await client.query(
        "SELECT 1 FROM room_memberships WHERE room_id = $1 AND user_id = $2", [row.id, normalizedUserId]
      );
      if (membership.rowCount) throw new RoomStoreError("ALREADY_JOINED", "이미 참여한 방입니다.");
      await client.query(`INSERT INTO room_memberships
        (room_id, organization_id, user_id, role, joined_at) VALUES ($1, $2, $3, 'member', $4)`,
      [row.id, normalizedOrganizationId, normalizedUserId, new Date().toISOString()]);
      return roomFromRow(row);
    });
  }

  async getMember(roomId, userId, organizationId) {
    await this.initialize();
    const row = (await this.database.query(`SELECT role, joined_at FROM room_memberships
      WHERE room_id = $1 AND user_id = $2 AND organization_id = $3`,
    [String(roomId || ""), String(userId || ""), String(organizationId || "")])).rows[0];
    return row ? { roomId, userId, organizationId, role: row.role, joinedAt: row.joined_at } : null;
  }

  async isMember(roomId, userId, organizationId) {
    return Boolean(await this.getMember(roomId, userId, organizationId));
  }

  async listForUser(userId, organizationId) {
    await this.initialize();
    const result = await this.database.query(`SELECT r.* FROM rooms r
      JOIN room_memberships rm ON rm.room_id = r.id AND rm.organization_id = r.organization_id
      WHERE rm.user_id = $1 AND r.organization_id = $2 ORDER BY r.created_at DESC`,
    [String(userId || ""), String(organizationId || "")]);
    return result.rows.map((row) => roomFromRow(row));
  }

  async close(id, organizationId, userId) {
    await this.initialize();
    return this.database.transaction(async (client) => {
      const row = (await client.query(
        "SELECT * FROM rooms WHERE id = $1 AND organization_id = $2 FOR UPDATE",
        [String(id || ""), String(organizationId || "")]
      )).rows[0];
      const current = roomFromRow(row);
      if (!current) throw new RoomStoreError("ROOM_NOT_FOUND", "종료할 방을 찾을 수 없습니다.");
      if (!userId || current.createdBy !== String(userId)) {
        throw new RoomStoreError("ROOM_FORBIDDEN", "방 생성자만 방을 종료할 수 있습니다.");
      }
      const now = new Date().toISOString();
      const hasMeetings = (await client.query(`SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'meetings'`)).rowCount > 0;
      if (hasMeetings) {
        await client.query(`UPDATE meetings SET status = 'completed',
          duration = GREATEST(duration, COALESCE((SELECT MAX("end") FROM meeting_segments WHERE meeting_id = meetings.id), 0)),
          ended_at = COALESCE(ended_at, $1), updated_at = $1
          WHERE organization_id = $2 AND room_id = $3 AND status = 'recording'`, [now, organizationId, id]);
      }
      if (current.status === "closed") return current;
      await client.query(`UPDATE rooms SET status = 'closed', closed_at = $1, updated_at = $1
        WHERE id = $2 AND organization_id = $3 AND status = 'active'`, [now, id, organizationId]);
      return this.#byId(client, id, organizationId);
    });
  }
}
