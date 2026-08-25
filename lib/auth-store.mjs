import { createHash, createHmac, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { openSqliteDatabase, parseJson, runTransaction } from "./sqlite-database.mjs";

const scryptAsync = promisify(scrypt);
const sessionLifetimeMs = 1000 * 60 * 60 * 24 * 30;
const verificationLifetimeMs = 10 * 60_000;
const verificationCooldownMs = 60_000;
const publicEmailDomains = new Set([
  "gmail.com", "googlemail.com", "naver.com", "daum.net", "hanmail.net",
  "kakao.com", "outlook.com", "hotmail.com", "icloud.com", "me.com"
]);
const dummyPasswordHash = `scrypt$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;

export class AuthError extends Error {
  constructor(message, status = 400, code = "AUTH_ERROR", details = {}) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
    Object.assign(this, details);
  }
}

function verificationHash(secret, userId, code) {
  return createHmac("sha256", secret).update(`${userId}:${code}`).digest("hex");
}

function safeHashEqual(left, right) {
  const first = Buffer.from(String(left || ""), "hex");
  const second = Buffer.from(String(right || ""), "hex");
  return first.length > 0 && first.length === second.length && timingSafeEqual(first, second);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function emailDomain(email) {
  return normalizeEmail(email).split("@")[1] || "";
}

function normalizeDomain(value) {
  return String(value || "").trim().toLocaleLowerCase().replace(/^@/, "");
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("base64url");
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
  if (!String(name || "").trim() || String(name).trim().length > 40) {
    throw new AuthError("이름은 1~40자로 입력해 주세요.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email))) {
    throw new AuthError("올바른 회사 이메일을 입력해 주세요.");
  }
  if (String(password || "").length < 8 || String(password).length > 128) {
    throw new AuthError("비밀번호는 8~128자로 입력해 주세요.");
  }
  normalizeIntroduction(introduction);
}

function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    introduction: row.introduction ?? null,
    emailVerifiedAt: row.email_verified_at,
    activeOrganizationId: row.active_organization_id,
    vocabulary: {
      roles: parseJson(row.roles_json, []),
      knownTerms: parseJson(row.known_terms_json, []),
      onboardedAt: row.onboarded_at
    },
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

export class AuthStore {
  constructor(rootDirectory, options = {}) {
    this.rootDirectory = rootDirectory;
    this.statePath = path.join(rootDirectory, "auth.json");
    this.databasePath = options.databasePath || path.join(rootDirectory, "auth.sqlite");
    this.verificationSecret = options.verificationSecret || "voice-partition-development-verification-secret";
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
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        introduction TEXT,
        active_organization_id TEXT,
        roles_json TEXT NOT NULL DEFAULT '[]',
        known_terms_json TEXT NOT NULL DEFAULT '[]',
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
    `);
    const sessionColumns = this.database.prepare("PRAGMA table_info(sessions)").all();
    if (!sessionColumns.some(({ name }) => name === "csrf_token")) {
      this.database.exec("ALTER TABLE sessions ADD COLUMN csrf_token TEXT");
    }
    const userColumns = this.database.prepare("PRAGMA table_info(users)").all();
    if (!userColumns.some(({ name }) => name === "email_verified_at")) {
      this.database.exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
      this.database.exec("UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL");
    }
    if (!userColumns.some(({ name }) => name === "introduction")) {
      this.database.exec("ALTER TABLE users ADD COLUMN introduction TEXT");
    }
    await this.#importLegacyJson();
  }

  async #importLegacyJson() {
    if (this.database.prepare("SELECT 1 FROM legacy_imports WHERE source = ?").get("auth-json-v1")) return;
    let legacy;
    try {
      legacy = JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`기존 인증 데이터를 읽지 못했습니다: ${error.message}`, { cause: error });
    }

    runTransaction(this.database, () => {
      let imported = 0;
      if (legacy) {
        const insertUser = this.database.prepare(`INSERT OR IGNORE INTO users
          (id, name, email, password_hash, introduction, active_organization_id, roles_json, known_terms_json, onboarded_at, email_verified_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`);
        for (const user of legacy.users || []) {
          insertUser.run(user.id, user.name, normalizeEmail(user.email), user.passwordHash, user.introduction ?? null,
            JSON.stringify(user.vocabulary?.roles || []), JSON.stringify(user.vocabulary?.knownTerms || []),
            user.vocabulary?.onboardedAt || null, user.createdAt, user.createdAt, user.updatedAt || user.createdAt);
          imported += 1;
        }
        const insertOrganization = this.database.prepare(`INSERT OR IGNORE INTO organizations
          (id, name, domain, invite_code, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const organization of legacy.organizations || []) {
          insertOrganization.run(organization.id, organization.name, organization.domain || null,
            organization.inviteCode, organization.createdBy, organization.createdAt);
          imported += 1;
        }
        const insertMembership = this.database.prepare(`INSERT OR IGNORE INTO memberships
          (user_id, organization_id, role, joined_at) VALUES (?, ?, ?, ?)`);
        for (const membership of legacy.memberships || []) {
          insertMembership.run(membership.userId, membership.organizationId, membership.role, membership.joinedAt);
          imported += 1;
        }
        const updateActive = this.database.prepare("UPDATE users SET active_organization_id = ? WHERE id = ?");
        for (const user of legacy.users || []) {
          if (user.activeOrganizationId) updateActive.run(user.activeOrganizationId, user.id);
        }
        const insertSession = this.database.prepare(`INSERT OR IGNORE INTO sessions
          (id, user_id, token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, NULL, ?, ?)`);
        for (const session of legacy.sessions || []) {
          insertSession.run(session.id, session.userId, session.tokenHash, session.expiresAt, session.createdAt);
          imported += 1;
        }
      }
      this.database.prepare("INSERT INTO legacy_imports(source, imported_at, record_count) VALUES (?, ?, ?)")
        .run("auth-json-v1", new Date().toISOString(), imported);
    });
  }

  async #ready() {
    await this.initialize();
    return this.database;
  }

  #userById(id) {
    return userFromRow(this.database.prepare("SELECT * FROM users WHERE id = ?").get(id));
  }

  #contextForUser(user) {
    const rows = this.database.prepare(`SELECT
      m.organization_id, m.role, m.joined_at,
      o.id, o.name, o.domain, o.invite_code, o.created_by, o.created_at
      FROM memberships m JOIN organizations o ON o.id = m.organization_id
      WHERE m.user_id = ? ORDER BY m.joined_at ASC`).all(user.id);
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
    const database = await this.#ready();
    const normalizedEmail = normalizeEmail(email);
    const normalizedIntroduction = normalizeIntroduction(introduction);
    const passwordHash = await hashPassword(String(password));
    return runTransaction(database, () => {
      if (database.prepare("SELECT 1 FROM users WHERE email = ?").get(normalizedEmail)) {
        throw new AuthError("이미 가입된 이메일입니다.", 409, "EMAIL_EXISTS");
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      database.prepare(`INSERT INTO users
        (id, name, email, password_hash, introduction, active_organization_id, roles_json, known_terms_json, onboarded_at, email_verified_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, '[]', '[]', NULL, NULL, ?, ?)`)
        .run(id, String(name).trim(), normalizedEmail, passwordHash, normalizedIntroduction, now, now);
      return selfUser(this.#userById(id));
    });
  }

  async authenticate(email, password) {
    const user = await this.#authenticateCredentials(email, password);
    if (!user.emailVerifiedAt) {
      throw new AuthError("이메일 인증을 완료해 주세요.", 403, "EMAIL_NOT_VERIFIED");
    }
    return selfUser(user);
  }

  async #authenticateCredentials(email, password) {
    const database = await this.#ready();
    const user = userFromRow(database.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email)));
    const passwordMatches = await verifyPassword(String(password || ""), user?.passwordHash || dummyPasswordHash);
    if (!user || !passwordMatches) {
      throw new AuthError("이메일 또는 비밀번호를 확인해 주세요.", 401, "INVALID_CREDENTIALS");
    }
    return user;
  }

  async issueEmailVerification(userId, options = {}) {
    const database = await this.#ready();
    const nowMs = Number(options.now) || Date.now();
    return runTransaction(database, () => {
      const user = this.#userById(userId);
      if (!user) throw new AuthError("사용자를 찾을 수 없습니다.", 404);
      if (user.emailVerifiedAt) throw new AuthError("이미 인증된 이메일입니다.", 409, "EMAIL_ALREADY_VERIFIED");
      const current = database.prepare("SELECT * FROM email_verifications WHERE user_id = ?").get(userId);
      if (current) {
        const retryAfterSeconds = Math.ceil((new Date(current.last_sent_at).getTime() + verificationCooldownMs - nowMs) / 1000);
        if (retryAfterSeconds > 0) {
          throw new AuthError(`인증 코드는 ${retryAfterSeconds}초 후 다시 요청할 수 있습니다.`, 429,
            "VERIFICATION_COOLDOWN", { retryAfterSeconds });
        }
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const now = new Date(nowMs).toISOString();
      const expiresAt = new Date(nowMs + verificationLifetimeMs).toISOString();
      database.prepare(`INSERT INTO email_verifications(user_id, code_hash, expires_at, attempt_count, last_sent_at, created_at)
        VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
        code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempt_count = 0, last_sent_at = excluded.last_sent_at`)
        .run(userId, verificationHash(this.verificationSecret, userId, code), expiresAt, now, now);
      return { user: selfUser(user), code, expiresAt };
    });
  }

  async resendEmailVerification(email, password, options = {}) {
    const user = await this.#authenticateCredentials(email, password);
    return this.issueEmailVerification(user.id, options);
  }

  async verifyEmail(email, code, options = {}) {
    const normalizedEmail = normalizeEmail(email);
    const normalizedCode = String(code || "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(normalizedCode)) {
      throw new AuthError("6자리 인증 코드를 입력해 주세요.", 400, "INVALID_VERIFICATION_CODE");
    }
    const database = await this.#ready();
    const nowMs = Number(options.now) || Date.now();
    const outcome = runTransaction(database, () => {
      const user = userFromRow(database.prepare("SELECT * FROM users WHERE email = ?").get(normalizedEmail));
      if (!user) throw new AuthError("인증 코드가 올바르지 않습니다.", 400, "INVALID_VERIFICATION_CODE");
      if (user.emailVerifiedAt) {
        throw new AuthError("이미 인증된 이메일입니다.", 409, "EMAIL_ALREADY_VERIFIED");
      }
      const verification = database.prepare("SELECT * FROM email_verifications WHERE user_id = ?").get(user.id);
      if (!verification || new Date(verification.expires_at).getTime() <= nowMs) {
        if (verification) database.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(user.id);
        return { error: new AuthError("인증 코드가 만료됐습니다. 새 코드를 요청해 주세요.", 410, "VERIFICATION_EXPIRED") };
      }
      const nextAttempts = Number(verification.attempt_count) + 1;
      const matches = safeHashEqual(verification.code_hash,
        verificationHash(this.verificationSecret, user.id, normalizedCode));
      if (!matches) {
        if (nextAttempts >= 5) {
          database.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(user.id);
          return { error: new AuthError("인증 시도 횟수를 초과했습니다. 새 코드를 요청해 주세요.", 429,
            "VERIFICATION_ATTEMPTS_EXCEEDED") };
        }
        database.prepare("UPDATE email_verifications SET attempt_count = ? WHERE user_id = ?").run(nextAttempts, user.id);
        return { error: new AuthError("인증 코드가 올바르지 않습니다.", 400, "INVALID_VERIFICATION_CODE",
          { remainingAttempts: 5 - nextAttempts }) };
      }
      const verifiedAt = new Date(nowMs).toISOString();
      database.prepare("UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?")
        .run(verifiedAt, verifiedAt, user.id);
      database.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(user.id);
      return { user: selfUser(this.#userById(user.id)) };
    });
    if (outcome.error) throw outcome.error;
    return outcome.user;
  }

  async createSession(userId) {
    const database = await this.#ready();
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
    runTransaction(database, () => {
      database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
      database.prepare("INSERT INTO sessions(id, user_id, token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), userId, tokenHash(token), csrfToken, expiresAt, now);
    });
    return { token, csrfToken, expiresAt };
  }

  async deleteSession(token) {
    if (!token) return;
    const database = await this.#ready();
    database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  async getContextBySession(token) {
    if (!token) return null;
    const database = await this.#ready();
    let session = database.prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?")
      .get(tokenHash(token), new Date().toISOString());
    if (!session) return null;
    if (!session.csrf_token) {
      const csrfToken = randomBytes(32).toString("base64url");
      database.prepare("UPDATE sessions SET csrf_token = ? WHERE id = ?").run(csrfToken, session.id);
      session = { ...session, csrf_token: csrfToken };
    }
    const user = this.#userById(session.user_id);
    return user ? { ...this.#contextForUser(user), csrfToken: session.csrf_token } : null;
  }

  async createOrganization(userId, { name, domain }) {
    const organizationName = String(name || "").trim();
    const normalizedDomain = normalizeDomain(domain);
    if (!organizationName || organizationName.length > 80) throw new AuthError("조직 이름은 1~80자로 입력해 주세요.");
    if (normalizedDomain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalizedDomain)) {
      throw new AuthError("올바른 회사 도메인을 입력해 주세요.");
    }
    const database = await this.#ready();
    return runTransaction(database, () => {
      const user = this.#userById(userId);
      if (!user) throw new AuthError("사용자를 찾을 수 없습니다.", 404);
      if (normalizedDomain && database.prepare("SELECT 1 FROM organizations WHERE domain = ?").get(normalizedDomain)) {
        throw new AuthError("이미 등록된 회사 도메인입니다. 초대 코드로 가입해 주세요.", 409, "DOMAIN_EXISTS");
      }
      const now = new Date().toISOString();
      const organizationId = randomUUID();
      database.prepare(`INSERT INTO organizations(id, name, domain, invite_code, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(organizationId, organizationName, normalizedDomain || null, randomBytes(4).toString("hex").toUpperCase(), userId, now);
      database.prepare("INSERT INTO memberships(user_id, organization_id, role, joined_at) VALUES (?, ?, 'owner', ?)")
        .run(userId, organizationId, now);
      database.prepare("UPDATE users SET active_organization_id = ?, updated_at = ? WHERE id = ?")
        .run(organizationId, now, userId);
      return this.#contextForUser(this.#userById(userId));
    });
  }

  async joinOrganization(userId, inviteCode) {
    const normalizedCode = String(inviteCode || "").trim().toUpperCase();
    if (!normalizedCode) throw new AuthError("초대 코드를 입력해 주세요.");
    const database = await this.#ready();
    return runTransaction(database, () => {
      const user = this.#userById(userId);
      const organization = organizationFromRow(database.prepare("SELECT * FROM organizations WHERE invite_code = ?").get(normalizedCode));
      if (!user) throw new AuthError("사용자를 찾을 수 없습니다.", 404);
      if (!organization) throw new AuthError("유효한 초대 코드를 찾지 못했습니다.", 404, "INVITE_NOT_FOUND");
      const now = new Date().toISOString();
      database.prepare(`INSERT OR IGNORE INTO memberships(user_id, organization_id, role, joined_at)
        VALUES (?, ?, 'member', ?)`)
        .run(userId, organization.id, now);
      database.prepare("UPDATE users SET active_organization_id = ?, updated_at = ? WHERE id = ?")
        .run(organization.id, now, userId);
      return this.#contextForUser(this.#userById(userId));
    });
  }

  async organizationSuggestion(userId) {
    const database = await this.#ready();
    const user = this.#userById(userId);
    if (!user) return null;
    const domain = emailDomain(user.email);
    if (!domain || publicEmailDomains.has(domain)) return null;
    const organization = organizationFromRow(database.prepare("SELECT * FROM organizations WHERE domain = ?").get(domain));
    return organization ? { id: organization.id, name: organization.name, domain: organization.domain } : { domain };
  }

  async updateProfile(userId, { introduction }) {
    const normalizedIntroduction = normalizeIntroduction(introduction);
    const database = await this.#ready();
    return runTransaction(database, () => {
      if (!this.#userById(userId)) throw new AuthError("사용자를 찾을 수 없습니다.", 404);
      const now = new Date().toISOString();
      database.prepare("UPDATE users SET introduction = ?, updated_at = ? WHERE id = ?")
        .run(normalizedIntroduction, now, userId);
      return this.#contextForUser(this.#userById(userId));
    });
  }

  async updateVocabulary(userId, { roles, knownTerms, onboarded = true }) {
    const database = await this.#ready();
    const safeRoles = [...new Set((Array.isArray(roles) ? roles : []).map((value) => String(value).trim()).filter(Boolean))].slice(0, 8);
    const safeTerms = [...new Set((Array.isArray(knownTerms) ? knownTerms : []).map((value) => String(value).trim()).filter(Boolean))].slice(0, 200);
    return runTransaction(database, () => {
      const user = this.#userById(userId);
      if (!user) throw new AuthError("사용자를 찾을 수 없습니다.", 404);
      const now = new Date().toISOString();
      const onboardedAt = onboarded ? (user.vocabulary?.onboardedAt || now) : null;
      database.prepare("UPDATE users SET roles_json = ?, known_terms_json = ?, onboarded_at = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(safeRoles), JSON.stringify(safeTerms), onboardedAt, now, userId);
      return this.#contextForUser(this.#userById(userId));
    });
  }

  async listMembers(userId, organizationId) {
    const database = await this.#ready();
    if (!database.prepare("SELECT 1 FROM memberships WHERE user_id = ? AND organization_id = ?").get(userId, organizationId)) {
      throw new AuthError("이 조직의 구성원이 아닙니다.", 403, "FORBIDDEN");
    }
    return database.prepare(`SELECT u.*, m.role, m.joined_at FROM memberships m
      JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY m.joined_at ASC`).all(organizationId)
      .map((row) => ({ ...memberUser(userFromRow(row)), role: row.role, joinedAt: row.joined_at }));
  }
}
