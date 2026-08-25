import { openSqliteDatabase, runTransaction } from "./sqlite-database.mjs";

const PROFILE_STATES = new Set(["ready", "invalid"]);

function required(value, name) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function normalizeState(value) {
  const state = String(value || "ready");
  if (!PROFILE_STATES.has(state)) throw new TypeError("state must be ready or invalid");
  return state;
}

function profileFromRow(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    speakerProfileId: row.speaker_profile_id,
    enrollmentOrganizationId: row.enrollment_organization_id,
    state: row.state,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hasCurrentMembership({ userId, currentOrganizationId, membership, memberships }) {
  const organizationId = required(currentOrganizationId, "currentOrganizationId");
  if (membership && !membership.organizationId && !membership.organization?.id && !membership.userId) return true;
  const candidates = membership ? [membership] : Array.isArray(memberships) ? memberships : [];
  return candidates.some((candidate) => candidate
    && (!candidate.userId || candidate.userId === userId)
    && (candidate.organizationId === organizationId || candidate.organization?.id === organizationId));
}

function conflict(existing, reason) {
  return { status: "conflict", reason, profile: existing || null };
}

export class VoiceProfileStore {
  constructor(databasePath) {
    this.databasePath = databasePath;
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
      CREATE TABLE IF NOT EXISTS user_voice_profiles (
        user_id TEXT PRIMARY KEY,
        speaker_profile_id TEXT NOT NULL UNIQUE,
        enrollment_organization_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('ready', 'invalid')),
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS user_voice_profiles_organization_idx
        ON user_voice_profiles(enrollment_organization_id, updated_at DESC);
    `);
  }

  async getByUserId(userId) {
    await this.initialize();
    return profileFromRow(this.database.prepare(
      "SELECT * FROM user_voice_profiles WHERE user_id = ?"
    ).get(required(userId, "userId")));
  }

  async getStatus(context) {
    const userId = required(context?.userId, "userId");
    if (!hasCurrentMembership({ ...context, userId })) return { authorized: false, profile: null };
    return { authorized: true, profile: await this.getByUserId(userId) };
  }

  async publishInitial(input) {
    await this.initialize();
    const userId = required(input?.userId, "userId");
    const speakerProfileId = required(input?.speakerProfileId, "speakerProfileId");
    const enrollmentOrganizationId = required(input?.enrollmentOrganizationId, "enrollmentOrganizationId");
    const state = normalizeState(input?.state);
    const now = input?.now || new Date().toISOString();

    return runTransaction(this.database, () => {
      const inserted = this.database.prepare(`
        INSERT INTO user_voice_profiles (
          user_id, speaker_profile_id, enrollment_organization_id, state, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(userId, speakerProfileId, enrollmentOrganizationId, state, now, now);
      if (inserted.changes === 1) {
        return { status: "published", profile: profileFromRow(this.database.prepare(
          "SELECT * FROM user_voice_profiles WHERE user_id = ?"
        ).get(userId)) };
      }
      const userProfile = profileFromRow(this.database.prepare(
        "SELECT * FROM user_voice_profiles WHERE user_id = ?"
      ).get(userId));
      if (userProfile) return conflict(userProfile, "user-already-has-profile");
      const claimedProfile = profileFromRow(this.database.prepare(
        "SELECT * FROM user_voice_profiles WHERE speaker_profile_id = ?"
      ).get(speakerProfileId));
      return conflict(claimedProfile, "speaker-profile-already-claimed");
    });
  }

  async replace(input) {
    await this.initialize();
    const userId = required(input?.userId, "userId");
    const speakerProfileId = required(input?.speakerProfileId, "speakerProfileId");
    const enrollmentOrganizationId = required(input?.enrollmentOrganizationId, "enrollmentOrganizationId");
    const expectedVersion = Number(input?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new TypeError("expectedVersion must be a positive integer");
    const state = normalizeState(input?.state);
    const now = input?.now || new Date().toISOString();

    return runTransaction(this.database, () => {
      try {
        const updated = this.database.prepare(`
          UPDATE user_voice_profiles
          SET speaker_profile_id = ?, enrollment_organization_id = ?, state = ?,
              version = version + 1, updated_at = ?
          WHERE user_id = ? AND version = ?
        `).run(speakerProfileId, enrollmentOrganizationId, state, now, userId, expectedVersion);
        if (updated.changes === 1) {
          return { status: "replaced", profile: profileFromRow(this.database.prepare(
            "SELECT * FROM user_voice_profiles WHERE user_id = ?"
          ).get(userId)) };
        }
      } catch (error) {
        if (!String(error?.message || "").includes("UNIQUE constraint failed")) throw error;
        const claimed = profileFromRow(this.database.prepare(
          "SELECT * FROM user_voice_profiles WHERE speaker_profile_id = ?"
        ).get(speakerProfileId));
        return conflict(claimed, "speaker-profile-already-claimed");
      }
      return conflict(profileFromRow(this.database.prepare(
        "SELECT * FROM user_voice_profiles WHERE user_id = ?"
      ).get(userId)), "version-mismatch");
    });
  }

  async markInvalid({ userId, expectedVersion, now = new Date().toISOString() }) {
    await this.initialize();
    return this.#updateState(required(userId, "userId"), expectedVersion, "invalid", now);
  }

  #updateState(userId, expectedVersion, state, now) {
    const version = Number(expectedVersion);
    if (!Number.isInteger(version) || version < 1) throw new TypeError("expectedVersion must be a positive integer");
    return runTransaction(this.database, () => {
      const updated = this.database.prepare(`
        UPDATE user_voice_profiles SET state = ?, version = version + 1, updated_at = ?
        WHERE user_id = ? AND version = ?
      `).run(state, now, userId, version);
      const current = profileFromRow(this.database.prepare(
        "SELECT * FROM user_voice_profiles WHERE user_id = ?"
      ).get(userId));
      return updated.changes === 1
        ? { status: "updated", profile: current }
        : conflict(current, "version-mismatch");
    });
  }

  async deletePointer({ userId, expectedVersion }) {
    await this.initialize();
    const normalizedUserId = required(userId, "userId");
    const version = Number(expectedVersion);
    if (!Number.isInteger(version) || version < 1) throw new TypeError("expectedVersion must be a positive integer");
    return runTransaction(this.database, () => {
      const current = profileFromRow(this.database.prepare(
        "SELECT * FROM user_voice_profiles WHERE user_id = ?"
      ).get(normalizedUserId));
      if (!current || current.version !== version) return conflict(current, "version-mismatch");
      this.database.prepare(
        "DELETE FROM user_voice_profiles WHERE user_id = ? AND version = ?"
      ).run(normalizedUserId, version);
      return { status: "deleted", profile: current };
    });
  }

  async claimLegacyCandidate({ userId, candidates, now = new Date().toISOString() }) {
    const normalizedUserId = required(userId, "userId");
    const owned = (Array.isArray(candidates) ? candidates : []).filter((candidate) =>
      candidate?.createdBy === normalizedUserId
      && String(candidate?.id || "").trim()
      && String(candidate?.organizationId || "").trim());
    if (owned.length !== 1) {
      return { status: owned.length === 0 ? "no-candidate" : "ambiguous", profile: null };
    }
    return this.publishInitial({
      userId: normalizedUserId,
      speakerProfileId: owned[0].id,
      enrollmentOrganizationId: owned[0].organizationId,
      state: "ready",
      now
    });
  }
}
