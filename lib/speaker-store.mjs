import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptBlob, encryptBlob, parseEncryptionKey } from "./secure-blob.mjs";

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

  async save(metadata, profile, referenceWav) {
    const directory = path.join(this.rootDirectory, metadata.id);
    const temporaryDirectory = path.join(this.rootDirectory, `${metadata.id}.partial-${randomUUID()}`);
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
    const existing = (await this.list(organizationId)).find(({ id }) => id === metadata.id);
    if (!existing) return null;
    const directory = path.join(this.rootDirectory, metadata.id);
    const suffix = randomUUID();
    const temporaryDirectory = path.join(this.rootDirectory, `${metadata.id}.partial-${suffix}`);
    const backupDirectory = path.join(this.rootDirectory, `${metadata.id}.backup-${suffix}`);
    const encryptedAtRest = Boolean(this.encryptionKey);
    const storedMetadata = {
      ...metadata,
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
      await rm(backupDirectory, { recursive: true, force: true }).catch(() => undefined);
      return storedMetadata;
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (backedUp && !(await exists(directory))) await rename(backupDirectory, directory).catch(() => undefined);
      throw error;
    }
  }

  async remove(id, organizationId = null) {
    if (organizationId) {
      const speakers = await this.list(organizationId);
      if (!speakers.some((speaker) => speaker.id === id)) return false;
    }
    await rm(path.join(this.rootDirectory, id), { recursive: true, force: true });
    return true;
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

  async loadProfiles(organizationId = null) {
    const speakers = await this.list(organizationId);
    return Promise.all(speakers.map(async (speaker) => {
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
    }));
  }
}
