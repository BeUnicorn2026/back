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

export class PostgresVoiceProfileStore {
  constructor(database) {
    this.database = database;
    this.initializing = null;
  }

  async initialize() {
    if (!this.initializing) this.initializing = this.#initialize();
    return this.initializing;
  }

  async #initialize() {
    await this.database.query(`
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
    const result = await this.database.query(
      "SELECT * FROM user_voice_profiles WHERE user_id = $1",
      [required(userId, "userId")]
    );
    return profileFromRow(result.rows[0]);
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

    return this.database.transaction(async (client) => {
      const inserted = await client.query(`
        INSERT INTO user_voice_profiles (
          user_id, speaker_profile_id, enrollment_organization_id, state, version, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 1, $5, $5)
        ON CONFLICT DO NOTHING
        RETURNING *
      `, [userId, speakerProfileId, enrollmentOrganizationId, state, now]);
      if (inserted.rows[0]) return { status: "published", profile: profileFromRow(inserted.rows[0]) };
      const byUser = await client.query(
        "SELECT * FROM user_voice_profiles WHERE user_id = $1", [userId]
      );
      if (byUser.rows[0]) return conflict(profileFromRow(byUser.rows[0]), "user-already-has-profile");
      const byProfile = await client.query(
        "SELECT * FROM user_voice_profiles WHERE speaker_profile_id = $1", [speakerProfileId]
      );
      return conflict(profileFromRow(byProfile.rows[0]), "speaker-profile-already-claimed");
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

    try {
      const result = await this.database.query(`
        UPDATE user_voice_profiles
        SET speaker_profile_id = $1, enrollment_organization_id = $2, state = $3,
            version = version + 1, updated_at = $4
        WHERE user_id = $5 AND version = $6
        RETURNING *
      `, [speakerProfileId, enrollmentOrganizationId, state, now, userId, expectedVersion]);
      if (result.rows[0]) return { status: "replaced", profile: profileFromRow(result.rows[0]) };
    } catch (error) {
      if (error?.code !== "23505" && !String(error?.message || "").toLowerCase().includes("unique")) throw error;
      const claimed = await this.database.query(
        "SELECT * FROM user_voice_profiles WHERE speaker_profile_id = $1", [speakerProfileId]
      );
      return conflict(profileFromRow(claimed.rows[0]), "speaker-profile-already-claimed");
    }
    const current = await this.database.query("SELECT * FROM user_voice_profiles WHERE user_id = $1", [userId]);
    return conflict(profileFromRow(current.rows[0]), "version-mismatch");
  }

  async markInvalid({ userId, expectedVersion, now = new Date().toISOString() }) {
    await this.initialize();
    const normalizedUserId = required(userId, "userId");
    const version = Number(expectedVersion);
    if (!Number.isInteger(version) || version < 1) throw new TypeError("expectedVersion must be a positive integer");
    const result = await this.database.query(`
      UPDATE user_voice_profiles SET state = 'invalid', version = version + 1, updated_at = $1
      WHERE user_id = $2 AND version = $3
      RETURNING *
    `, [now, normalizedUserId, version]);
    if (result.rows[0]) return { status: "updated", profile: profileFromRow(result.rows[0]) };
    return conflict(await this.getByUserId(normalizedUserId), "version-mismatch");
  }

  async deletePointer({ userId, expectedVersion }) {
    await this.initialize();
    const normalizedUserId = required(userId, "userId");
    const version = Number(expectedVersion);
    if (!Number.isInteger(version) || version < 1) throw new TypeError("expectedVersion must be a positive integer");
    const result = await this.database.query(`
      DELETE FROM user_voice_profiles WHERE user_id = $1 AND version = $2 RETURNING *
    `, [normalizedUserId, version]);
    if (result.rows[0]) return { status: "deleted", profile: profileFromRow(result.rows[0]) };
    return conflict(await this.getByUserId(normalizedUserId), "version-mismatch");
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
