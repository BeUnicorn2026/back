import { createHash, createHmac, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { AuthError } from "./auth-store.mjs";

const scryptAsync = promisify(scrypt);
const sessionLifetimeMs = 30 * 24 * 60 * 60_000;
const verificationLifetimeMs = 10 * 60_000;
const verificationCooldownMs = 60_000;
const publicEmailDomains = new Set([
  "gmail.com", "googlemail.com", "naver.com", "daum.net", "hanmail.net",
  "kakao.com", "outlook.com", "hotmail.com", "icloud.com", "me.com"
]);
const dummyPasswordHash = `scrypt$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;

function normalizeEmail(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function normalizeDomain(value) {
  return String(value || "").trim().toLocaleLowerCase().replace(/^@/, "");
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("base64url");
}

function verificationHash(secret, userId, code) {
  return createHmac("sha256", secret).update(`${userId}:${code}`).digest("hex");
}

function safeHashEqual(left, right) {
  const first = Buffer.from(String(left || ""), "hex");
  const second = Buffer.from(String(right || ""), "hex");
  return first.length > 0 && first.length === second.length && timingSafeEqual(first, second);
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${Buffer.from(derived).toString("base64url")}`;
}

async function verifyPassword(password, stored) {
  const [algorithm, encodedSalt, encodedHash] = String(stored || "").split("$");
  if (algorithm !== "scrypt" || !encodedSalt || !encodedHash) return false;
  const expected = Buffer.from(encodedHash, "base64url");
  const actual = Buffer.from(await scryptAsync(password, Buffer.from(encodedSalt, "base64url"), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeIntroduction(value) {
  const introduction = String(value ?? "").trim();
  if (!introduction || introduction.length > 500) {
    throw new AuthError("자기소개는 1~500자로 입력해 주세요.", 400, "INTRODUCTION_INVALID");
  }
  return introduction;
}

function validateAccount({ name, email, password, introduction }) {
  if (!String(name || "").trim() || String(name).trim().length > 40) throw new AuthError("이름은 1~40자로 입력해 주세요.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))) throw new AuthError("올바른 회사 이메일을 입력해 주세요.");
  if (String(password || "").length < 8 || String(password).length > 128) throw new AuthError("비밀번호는 8~128자로 입력해 주세요.");
  normalizeIntroduction(introduction);
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || "[]"); } catch { return []; }
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    introduction: row.introduction ?? null,
    activeOrganizationId: row.active_organization_id,
    vocabulary: {
      roles: jsonArray(row.roles_json),
      knownTerms: jsonArray(row.known_terms_json),
      onboardedAt: row.onboarded_at
    },
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function selfUser(user) {
  if (!user) return null;
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

function memberUser(user) {
  if (!user) return null;
  const { passwordHash: _passwordHash, introduction: _introduction, ...safe } = user;
  return safe;
}

function organizationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    inviteCode: row.invite_code,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

function postgresConflict(error) {
  return error?.code === "23505";
}

export class PostgresAuthStore {
  constructor(database, options = {}) {
    this.database = database;
    this.verificationSecret = options.verificationSecret;
    if (!this.verificationSecret) throw new Error("PostgreSQL 인증 저장소에는 verificationSecret이 필요합니다.");
    this.initializing = null;
  }

  async initialize() {
    if (!this.initializing) this.initializing = this.#initialize();
    return this.initializing;
  }

  async #initialize() {
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        introduction TEXT,
        active_organization_id TEXT,
        roles_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        known_terms_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        onboarded_at TEXT,
        email_verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT UNIQUE,
        invite_code TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY (user_id, organization_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_verifications (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_sent_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS memberships_organization_idx ON memberships(organization_id);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS introduction TEXT;
    `);
  }

  async #userById(queryable, id) {
    return userFromRow((await queryable.query("SELECT * FROM users WHERE id = $1", [id])).rows[0]);
  }

  async #contextForUser(queryable, user) {
    const rows = (await queryable.query(`SELECT
      m.organization_id, m.role, m.joined_at,
      o.id, o.name, o.domain, o.invite_code, o.created_by, o.created_at
      FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = $1 ORDER BY m.joined_at ASC`, [user.id])).rows;
    const memberships = rows.map((row) => ({
      organizationId: row.organization_id,
      role: row.role,
      joinedAt: row.joined_at,
      organization: organizationFromRow(row)
    }));
    const active = memberships.find(({ organizationId }) => organizationId === user.activeOrganizationId) || memberships[0] || null;
    return {
      user: selfUser(user),
      organization: active?.organization || null,
      membership: active ? { role: active.role, joinedAt: active.joinedAt } : null,
      organizations: memberships.map(({ organization, role }) => ({ ...organization, role }))
    };
  }

  async signup({ name, email, password, introduction }) {
    validateAccount({ name, email, password, introduction });
    await this.initialize();
    const normalizedEmail = normalizeEmail(email);
    const normalizedIntroduction = normalizeIntroduction(introduction);
    const passwordHash = await hashPassword(String(password));
    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      await this.database.query(`INSERT INTO users
        (id, name, email, password_hash, introduction, active_organization_id, roles_json, known_terms_json, onboarded_at, email_verified_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, NULL, '[]'::jsonb, '[]'::jsonb, NULL, NULL, $6, $6)`,
      [id, String(name).trim(), normalizedEmail, passwordHash, normalizedIntroduction, now]);
    } catch (error) {
      if (postgresConflict(error)) throw new AuthError("이미 가입된 이메일입니다.", 409, "EMAIL_EXISTS");
      throw error;
    }
    return selfUser(await this.#userById(this.database, id));
  }

  async #authenticateCredentials(email, password) {
    await this.initialize();
    const user = userFromRow((await this.database.query("SELECT * FROM users WHERE email = $1", [normalizeEmail(email)])).rows[0]);
    const passwordMatches = await verifyPassword(String(password || ""), user?.passwordHash || dummyPasswordHash);
    if (!user || !passwordMatches) throw new AuthError("이메일 또는 비밀번호를 확인해 주세요.", 401, "INVALID_CREDENTIALS");
    return user;
  }

  async authenticate(email, password) {
    const user = await this.#authenticateCredentials(email, password);
    if (!user.emailVerifiedAt) throw new AuthError("이메일 인증을 완료해 주세요.", 403, "EMAIL_NOT_VERIFIED");
    return selfUser(user);
  }

  async issueEmailVerification(userId, options = {}) {
    await this.initialize();
    const nowMs = Number(options.now) || Date.now();
    return this.database.transaction(async (client) => {
      const user = await this.#userById(client, userId);
      if (!user) throw new AuthError("사용자를 찾을 수 없습니다.", 404);
      if (user.emailVerifiedAt) throw new AuthError("이미 인증된 이메일입니다.", 409, "EMAIL_ALREADY_VERIFIED");
      const current = (await client.query("SELECT * FROM email_verifications WHERE user_id = $1 FOR UPDATE", [userId])).rows[0];
      if (current) {
        const retryAfterSeconds = Math.ceil((new Date(current.last_sent_at).getTime() + verificationCooldownMs - nowMs) / 1000);
        if (retryAfterSeconds > 0) throw new AuthError(`인증 코드는 ${retryAfterSeconds}초 후 다시 요청할 수 있습니다.`,
          429, "VERIFICATION_COOLDOWN", { retryAfterSeconds });
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const now = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + verificationLifetimeMs).toISOString();
      await client.query(`INSERT INTO email_verifications(user_id, code_hash, expires_at, attempt_count, last_sent_at, created_at)
        VALUES ($1, $2, $3, 0, $4, $4) ON CONFLICT(user_id) DO UPDATE SET
        code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempt_count = 0, last_sent_at = EXCLUDED.last_sent_at`,
      [userId, verificationHash(this.verificationSecret, userId, code), expiresAt, now]);
      return { user: selfUser(user), code, expiresAt };
    });
  }

  async resendEmailVerification(email, password, options = {}) {
    const user = await this.#authenticateCredentials(email, password);
    return this.issueEmailVerification(user.id, options);
  }

  async verifyEmail(email, code, options = {}) {
    const normalizedCode = String(code || "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(normalizedCode)) throw new AuthError("6자리 인증 코드를 입력해 주세요.", 400, "INVALID_VERIFICATION_CODE");
    await this.initialize();
    const nowMs = Number(options.now) || Date.now();
    const outcome = await this.database.transaction(async (client) => {
      const user = userFromRow((await client.query("SELECT * FROM users WHERE email = $1 FOR UPDATE", [normalizeEmail(email)])).rows[0]);
      if (!user) throw new AuthError("인증 코드가 올바르지 않습니다.", 400, "INVALID_VERIFICATION_CODE");
      if (user.emailVerifiedAt) {
        throw new AuthError("이미 인증된 이메일입니다.", 409, "EMAIL_ALREADY_VERIFIED");
      }
      const verification = (await client.query("SELECT * FROM email_verifications WHERE user_id = $1 FOR UPDATE", [user.id])).rows[0];
      if (!verification || new Date(verification.expires_at).getTime() <= nowMs) {
        if (verification) await client.query("DELETE FROM email_verifications WHERE user_id = $1", [user.id]);
        return { error: new AuthError("인증 코드가 만료됐습니다. 새 코드를 요청해 주세요.", 410, "VERIFICATION_EXPIRED") };
      }
      const nextAttempts = Number(verification.attempt_count) + 1;
      if (!safeHashEqual(verification.code_hash, verificationHash(this.verificationSecret, user.id, normalizedCode))) {
        if (nextAttempts >= 5) {
          await client.query("DELETE FROM email_verifications WHERE user_id = $1", [user.id]);
          return { error: new AuthError("인증 시도 횟수를 초과했습니다. 새 코드를 요청해 주세요.", 429,
            "VERIFICATION_ATTEMPTS_EXCEEDED") };
        }
        await client.query("UPDATE email_verifications SET attempt_count = $1 WHERE user_id = $2", [nextAttempts, user.id]);
        return { error: new AuthError("인증 코드가 올바르지 않습니다.", 400, "INVALID_VERIFICATION_CODE",
          { remainingAttempts: 5 - nextAttempts }) };
      }
      const verifiedAt = new Date(nowMs).toISOString();
      await client.query("UPDATE users SET email_verified_at = $1, updated_at = $1 WHERE id = $2", [verifiedAt, user.id]);
      await client.query("DELETE FROM email_verifications WHERE user_id = $1", [user.id]);
      return { user: selfUser(await this.#userById(client, user.id)) };
    });
    if (outcome.error) throw outcome.error;
    return outcome.user;
  }

  async createSession(userId) {
    await this.initialize();
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
    await this.database.transaction(async (client) => {
      await client.query("DELETE FROM sessions WHERE expires_at <= $1", [now]);
      await client.query(`INSERT INTO sessions(id, user_id, token_hash, csrf_token, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)`, [randomUUID(), userId, tokenHash(token), csrfToken, expiresAt, now]);
    });
    return { token, csrfToken, expiresAt };
  }

  async deleteSession(token) {
    if (!token) return;
    await this.initialize();
    await this.database.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
  }

  async getContextBySession(token) {
    if (!token) return null;
    await this.initialize();
    return this.database.transaction(async (client) => {
      let session = (await client.query("SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > $2", [tokenHash(token), new Date().toISOString()])).rows[0];
      if (!session) return null;
      if (!session.csrf_token) {
        const csrfToken = randomBytes(32).toString("base64url");
        await client.query("UPDATE sessions SET csrf_token = $1 WHERE id = $2", [csrfToken, session.id]);
        session = { ...session, csrf_token: csrfToken };
      }
      const user = await this.#userById(client, session.user_id);
      return user ? { ...await this.#contextForUser(client, user), csrfToken: session.csrf_token } : null;
    });
  }

  async createOrganization(userId, { name, domain }) {
    const organizationName = String(name || "").trim();
    const normalizedDomain = normalizeDomain(domain);
    if (!organizationName || organizationName.length > 80) throw new AuthError("조직 이름은 1~80자로 입력해 주세요.");
    if (normalizedDomain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalizedDomain)) throw new AuthError("올바른 회사 도메인을 입력해 주세요.");
    await this.initialize();
    try {
      return await this.database.transaction(async (client) => {
        const user = await this.#userById(client, userId);
        if (!user) throw new AuthError("사용자를 찾을 수 없습니다.", 404);
        if (normalizedDomain && (await client.query("SELECT 1 FROM organizations WHERE domain = $1", [normalizedDomain])).rowCount) {
          throw new AuthError("이미 등록된 회사 도메인입니다. 초대 코드로 가입해 주세요.", 409, "DOMAIN_EXISTS");
        }
        const now = new Date().toISOString();
        const organizationId = randomUUID();
        await client.query(`INSERT INTO organizations(id, name, domain, invite_code, created_by, created_at)
          VALUES ($1, $2, $3, $4, $5, $6)`,
        [organizationId, organizationName, normalizedDomain || null, randomBytes(4).toString("hex").toUpperCase(), userId, now]);
        await client.query("INSERT INTO memberships(user_id, organization_id, role, joined_at) VALUES ($1, $2, 'owner', $3)",
          [userId, organizationId, now]);
        await client.query("UPDATE users SET active_organization_id = $1, updated_at = $2 WHERE id = $3", [organizationId, now, userId]);
        return this.#contextForUser(client, await this.#userById(client, userId));
      });
    } catch (error) {
      if (postgresConflict(error)) throw new AuthError("이미 등록된 회사 도메인입니다. 초대 코드로 가입해 주세요.", 409, "DOMAIN_EXISTS");
      throw error;
    }
  }

  async joinOrganization(userId, inviteCode) {
    const normalizedCode = String(inviteCode || "").trim().toUpperCase();
    if (!normalizedCode) throw new AuthError("초대 코드를 입력해 주세요.");
    await this.initialize();
    return this.database.transaction(async (client) => {
      const user = await this.#userById(client, userId);
      const organization = organizationFromRow((await client.query("SELECT * FROM organizations WHERE invite_code = $1", [normalizedCode])).rows[0]);
      if (!user) throw new AuthError("사용자를 찾을 수 없습니다.", 404);
      if (!organization) throw new AuthError("유효한 초대 코드를 찾지 못했습니다.", 404, "INVITE_NOT_FOUND");
      const now = new Date().toISOString();
      await client.query(`INSERT INTO memberships(user_id, organization_id, role, joined_at)
        VALUES ($1, $2, 'member', $3) ON CONFLICT(user_id, organization_id) DO NOTHING`, [userId, organization.id, now]);
      await client.query("UPDATE users SET active_organization_id = $1, updated_at = $2 WHERE id = $3", [organization.id, now, userId]);
      return this.#contextForUser(client, await this.#userById(client, userId));
    });
  }

  async organizationSuggestion(userId) {
    await this.initialize();
    const user = await this.#userById(this.database, userId);
    if (!user) return null;
    const domain = normalizeEmail(user.email).split("@")[1] || "";
    if (!domain || publicEmailDomains.has(domain)) return null;
    const organization = organizationFromRow((await this.database.query("SELECT * FROM organizations WHERE domain = $1", [domain])).rows[0]);
    return organization ? { id: organization.id, name: organization.name, domain: organization.domain } : { domain };
  }

  async updateProfile(userId, { introduction }) {
    const normalizedIntroduction = normalizeIntroduction(introduction);
    await this.initialize();
    return this.database.transaction(async (client) => {
      if (!await this.#userById(client, userId)) throw new AuthError("사용자를 찾을 수 없습니다.", 404);
      const now = new Date().toISOString();
      await client.query("UPDATE users SET introduction = $1, updated_at = $2 WHERE id = $3",
        [normalizedIntroduction, now, userId]);
      return this.#contextForUser(client, await this.#userById(client, userId));
    });
  }

  async updateVocabulary(userId, { roles, knownTerms, onboarded = true }) {
    const safeRoles = [...new Set((Array.isArray(roles) ? roles : []).map((value) => String(value).trim()).filter(Boolean))].slice(0, 8);
    const safeTerms = [...new Set((Array.isArray(knownTerms) ? knownTerms : []).map((value) => String(value).trim()).filter(Boolean))].slice(0, 200);
    await this.initialize();
    return this.database.transaction(async (client) => {
      const user = await this.#userById(client, userId);
      if (!user) throw new AuthError("사용자를 찾을 수 없습니다.", 404);
      const now = new Date().toISOString();
      const onboardedAt = onboarded ? (user.vocabulary?.onboardedAt || now) : null;
      await client.query(`UPDATE users SET roles_json = $1::jsonb, known_terms_json = $2::jsonb,
        onboarded_at = $3, updated_at = $4 WHERE id = $5`,
      [JSON.stringify(safeRoles), JSON.stringify(safeTerms), onboardedAt, now, userId]);
      return this.#contextForUser(client, await this.#userById(client, userId));
    });
  }

  async listMembers(userId, organizationId) {
    await this.initialize();
    if (!(await this.database.query("SELECT 1 FROM memberships WHERE user_id = $1 AND organization_id = $2", [userId, organizationId])).rowCount) {
      throw new AuthError("이 조직의 구성원이 아닙니다.", 403, "FORBIDDEN");
    }
    const rows = (await this.database.query(`SELECT u.*, m.role, m.joined_at FROM memberships m
      JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 ORDER BY m.joined_at ASC`, [organizationId])).rows;
    return rows.map((row) => ({ ...memberUser(userFromRow(row)), role: row.role, joinedAt: row.joined_at }));
  }
}
