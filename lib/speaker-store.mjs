import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptBlob, encryptBlob, parseEncryptionKey } from "./secure-blob.mjs";

function safeSpeakerId(id) {
  const normalized = String(id || "");
  if (!/^[a-zA-Z0-9_-]+$/.test(normalized)) throw new Error("안전하지 않은 화자 ID입니다.");
  return normalized;
}

async function removeObsoleteDirectory(directory) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      failure = error;
    }
  }
  const error = new Error("교체된 이전 생체정보 파일을 정리하지 못했습니다.", { cause: failure });
  error.code = "OBSOLETE_BIOMETRIC_CLEANUP_FAILED";
  throw error;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class SpeakerStore {
  constructor(rootDirectory, options = {}) {
    this.rootDirectory = rootDirectory;
    this.encryptionKey = parseEncryptionKey(options.encryptionKey);
    this.requireEncryption = Boolean(options.requireEncryption);
    this.initialized = false;
    if (this.requireEncryption && !this.encryptionKey) {
      throw new Error("운영 환경에는 VOICE_BIOMETRIC_KEY가 반드시 필요합니다.");
    }
  }

  async initialize() {
    if (this.initialized) return;
    await mkdir(this.rootDirectory, { recursive: true });
    if (this.requireEncryption) {
      const entries = await readdir(this.rootDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const metadata = JSON.parse(await readFile(path.join(this.rootDirectory, entry.name, "speaker.json"), "utf8"));
          if (metadata.encryption?.version !== 1) {
            throw new Error(`평문 화자 프로필(${metadata.name || entry.name})이 있습니다. 먼저 npm run migrate:speaker-encryption을 실행해 주세요.`);
          }
          const directory = path.join(this.rootDirectory, entry.name);
          const [profile, reference] = await Promise.all([
            readFile(path.join(directory, "profile.bin.enc")),
            readFile(path.join(directory, "reference.wav.enc"))
          ]);
          decryptBlob(profile, this.encryptionKey, `${metadata.id}:profile`);
          decryptBlob(reference, this.encryptionKey, `${metadata.id}:reference`);
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
    this.initialized = true;
  }

  async list(organizationId = null) {
    await this.initialize();
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });
    const speakers = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const metadata = JSON.parse(await readFile(path.join(this.rootDirectory, entry.name, "speaker.json"), "utf8"));
        if (!organizationId || metadata.organizationId === organizationId) {
          speakers.push({ ...metadata, encryptedAtRest: metadata.encryption?.version === 1 });
        }
      } catch {
        // Ignore incomplete enrollment directories.
      }
    }

    return speakers.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id, organizationId = null) {
    await this.initialize();
    const speakerId = safeSpeakerId(id);
    try {
      const metadata = JSON.parse(await readFile(path.join(this.rootDirectory, speakerId, "speaker.json"), "utf8"));
      if (metadata.id !== speakerId || (organizationId && metadata.organizationId !== organizationId)) return null;
      return { ...metadata, encryptedAtRest: metadata.encryption?.version === 1 };
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async save(metadata, profile, referenceWav) {
    await this.initialize();
    const speakerId = safeSpeakerId(metadata.id);
    const directory = path.join(this.rootDirectory, speakerId);
    const temporaryDirectory = path.join(this.rootDirectory, `${speakerId}.partial-${randomUUID()}`);
    const encryptedAtRest = Boolean(this.encryptionKey);
    const storedMetadata = {
      ...metadata,
      encryptedAtRest,
      encryption: encryptedAtRest ? { version: 1, algorithm: "AES-256-GCM" } : null
    };
    await mkdir(temporaryDirectory, { recursive: true });
    try {
      await this.#writePayload(temporaryDirectory, storedMetadata, profile, referenceWav);
      await rename(temporaryDirectory, directory);
      return storedMetadata;
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async #writePayload(directory, metadata, profile, referenceWav) {
    const writes = [writeFile(path.join(directory, "speaker.json"), JSON.stringify(metadata, null, 2))];
    if (this.encryptionKey) {
      writes.push(
        writeFile(path.join(directory, "profile.bin.enc"), encryptBlob(profile, this.encryptionKey, `${metadata.id}:profile`)),
        writeFile(path.join(directory, "reference.wav.enc"), encryptBlob(referenceWav, this.encryptionKey, `${metadata.id}:reference`))
      );
    } else {
      writes.push(
        writeFile(path.join(directory, "profile.bin"), profile),
        writeFile(path.join(directory, "reference.wav"), referenceWav)
      );
    }
    await Promise.all(writes);
  }

  async replace(metadata, profile, referenceWav, organizationId) {
    await this.initialize();
    const existing = await this.get(metadata.id, organizationId);
    if (!existing) return null;
    const directory = path.join(this.rootDirectory, metadata.id);
    const suffix = randomUUID();
    const temporaryDirectory = path.join(this.rootDirectory, `${metadata.id}.partial-${suffix}`);
    const backupDirectory = path.join(this.rootDirectory, `${metadata.id}.backup-${suffix}`);
    const encryptedAtRest = Boolean(this.encryptionKey);
    const storedMetadata = {
      ...metadata,
      id: existing.id,
      organizationId: existing.organizationId,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      encryptedAtRest,
      encryption: encryptedAtRest ? { version: 1, algorithm: "AES-256-GCM" } : null
    };
    await mkdir(temporaryDirectory, { recursive: true });
    let backedUp = false;
    try {
      await this.#writePayload(temporaryDirectory, storedMetadata, profile, referenceWav);
      await rename(directory, backupDirectory);
      backedUp = true;
      await rename(temporaryDirectory, directory);
      await removeObsoleteDirectory(backupDirectory);
      return storedMetadata;
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (backedUp && !(await exists(directory))) await rename(backupDirectory, directory).catch(() => undefined);
      throw error;
    }
  }

  async replaceOwned(metadata, profile, referenceWav, createdBy) {
    const existing = await this.get(metadata.id);
    if (!existing || !existing.createdBy || existing.createdBy !== createdBy) return null;
    return this.replace(metadata, profile, referenceWav, existing.organizationId);
  }

  async updateMetadata(id, organizationId, changes = {}) {
    await this.initialize();
    const existing = await this.get(id, organizationId);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...changes,
      id: existing.id,
      organizationId: existing.organizationId,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      encryption: existing.encryption
    };
    const metadataPath = path.join(this.rootDirectory, id, "speaker.json");
    const temporaryPath = `${metadataPath}.partial-${randomUUID()}`;
    await writeFile(temporaryPath, JSON.stringify(updated, null, 2));
    await rename(temporaryPath, metadataPath);
    return { ...updated, encryptedAtRest: updated.encryption?.version === 1 };
  }

  async updateMetadataOwned(id, createdBy, changes = {}) {
    const existing = await this.get(id);
    if (!existing || !existing.createdBy || existing.createdBy !== createdBy) return null;
    return this.updateMetadata(id, existing.organizationId, changes);
  }

  async remove(id, organizationId = null) {
    const speakerId = safeSpeakerId(id);
    if (organizationId && !(await this.get(speakerId, organizationId))) return false;
    await rm(path.join(this.rootDirectory, speakerId), { recursive: true, force: true });
    return true;
  }

  async removeOwned(id, createdBy) {
    const existing = await this.get(id);
    if (!existing || !existing.createdBy || existing.createdBy !== createdBy) return false;
    return this.remove(id, existing.organizationId);
  }

  async migrationPlan() {
    const speakers = await this.list();
    const plan = [];
    for (const speaker of speakers) {
      const directory = path.join(this.rootDirectory, speaker.id);
      const plaintextProfile = await exists(path.join(directory, "profile.bin"));
      const plaintextReference = await exists(path.join(directory, "reference.wav"));
      plan.push({
        id: speaker.id,
        name: speaker.name,
        encrypted: speaker.encryption?.version === 1,
        plaintextFiles: [plaintextProfile && "profile.bin", plaintextReference && "reference.wav"].filter(Boolean)
      });
    }
    return plan;
  }

  async migratePlaintext({ commit = false } = {}) {
    if (!this.encryptionKey) throw new Error("마이그레이션에는 VOICE_BIOMETRIC_KEY가 필요합니다.");
    const plan = await this.migrationPlan();
    if (!commit) return { committed: false, plan };

    const migrated = [];
    for (const item of plan) {
      if (!item.plaintextFiles.length) continue;
      const directory = path.join(this.rootDirectory, item.id);
      const metadataPath = path.join(directory, "speaker.json");
      const profilePath = path.join(directory, "profile.bin");
      const referencePath = path.join(directory, "reference.wav");
      const encryptedProfilePath = path.join(directory, "profile.bin.enc");
      const encryptedReferencePath = path.join(directory, "reference.wav.enc");
      let metadata = JSON.parse(await readFile(metadataPath, "utf8"));

      if (metadata.encryption?.version !== 1) {
        if (!(await exists(profilePath)) || !(await exists(referencePath))) {
          throw new Error(`${item.name}: 평문 profile.bin과 reference.wav가 모두 필요합니다.`);
        }
        const [profile, reference] = await Promise.all([readFile(profilePath), readFile(referencePath)]);
        const suffix = `.partial-${randomUUID()}`;
        const profileTemporary = `${encryptedProfilePath}${suffix}`;
        const referenceTemporary = `${encryptedReferencePath}${suffix}`;
        const metadataTemporary = `${metadataPath}${suffix}`;
        metadata = { ...metadata, encryptedAtRest: true, encryption: { version: 1, algorithm: "AES-256-GCM" } };
        await Promise.all([
          writeFile(profileTemporary, encryptBlob(profile, this.encryptionKey, `${item.id}:profile`)),
          writeFile(referenceTemporary, encryptBlob(reference, this.encryptionKey, `${item.id}:reference`)),
          writeFile(metadataTemporary, JSON.stringify(metadata, null, 2))
        ]);
        await rename(profileTemporary, encryptedProfilePath);
        await rename(referenceTemporary, encryptedReferencePath);
        await rename(metadataTemporary, metadataPath);
      }

      const [encryptedProfile, encryptedReference] = await Promise.all([
        readFile(encryptedProfilePath), readFile(encryptedReferencePath)
      ]);
      decryptBlob(encryptedProfile, this.encryptionKey, `${item.id}:profile`);
      decryptBlob(encryptedReference, this.encryptionKey, `${item.id}:reference`);
      await Promise.all([
        rm(profilePath, { force: true }),
        rm(referencePath, { force: true })
      ]);
      migrated.push({ id: item.id, name: item.name });
    }
    return { committed: true, migrated, plan: await this.migrationPlan() };
  }

  async loadProfile(id, organizationId = null) {
    const speaker = await this.get(id, organizationId);
    if (!speaker) return null;
    const directory = path.join(this.rootDirectory, speaker.id);
    const encrypted = speaker.encryption?.version === 1;
    if (encrypted && !this.encryptionKey) throw new Error("암호화된 목소리를 읽으려면 VOICE_BIOMETRIC_KEY가 필요합니다.");
    const profilePayload = await readFile(path.join(directory, encrypted ? "profile.bin.enc" : "profile.bin"));
    const referencePayload = await readFile(path.join(directory, encrypted ? "reference.wav.enc" : "reference.wav"));
    const profileBuffer = encrypted ? decryptBlob(profilePayload, this.encryptionKey, `${speaker.id}:profile`) : profilePayload;
    const referenceAudio = encrypted ? decryptBlob(referencePayload, this.encryptionKey, `${speaker.id}:reference`) : referencePayload;
    const profileView = new Float32Array(Uint8Array.from(profileBuffer).buffer);
    const values = Float32Array.from(profileView);
    const dimensions = Number(speaker.profileDimensions) || 512;
    const profiles = [];
    for (let offset = 0; offset + dimensions <= values.length; offset += dimensions) {
      profiles.push(values.slice(offset, offset + dimensions));
    }
    return {
      ...speaker,
      profile: profiles[0] || values,
      profiles: profiles.length ? profiles : [values],
      referenceAudio
    };
  }

  async loadOwnedProfile(id, createdBy) {
    const speaker = await this.get(id);
    if (!speaker || !speaker.createdBy || speaker.createdBy !== createdBy) return null;
    return this.loadProfile(id, speaker.organizationId);
  }

  async loadProfiles(organizationId = null) {
    const speakers = await this.list(organizationId);
    return Promise.all(speakers.map((speaker) => this.loadProfile(speaker.id, speaker.organizationId)));
  }
}
