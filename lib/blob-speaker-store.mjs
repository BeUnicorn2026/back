import { del, get, list, put } from "@vercel/blob";
import { randomUUID } from "node:crypto";
import { decryptBlob, encryptBlob, parseEncryptionKey } from "./secure-blob.mjs";

const defaultClient = { del, get, list, put };

async function streamToBuffer(stream) {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

export class BlobSpeakerStore {
  constructor(options = {}) {
    this.token = options.token || "";
    this.prefix = String(options.prefix || "voice-partition/speakers").replace(/^\/+|\/+$/g, "");
    this.encryptionKey = parseEncryptionKey(options.encryptionKey);
    this.client = options.client || defaultClient;
    this.initialized = false;
    if (!this.token && this.client === defaultClient) throw new Error("Blob 화자 저장소에는 BLOB_READ_WRITE_TOKEN이 필요합니다.");
    if (!this.encryptionKey) throw new Error("Blob 화자 저장소에는 VOICE_BIOMETRIC_KEY가 필요합니다.");
  }

  #pathname(id, filename) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id))) throw new Error("안전하지 않은 화자 ID입니다.");
    return `${this.prefix}/${id}/${filename}`;
  }

  async #read(id, filename) {
    const result = await this.client.get(this.#pathname(id, filename), {
      access: "private",
      token: this.token,
      useCache: false,
      abortSignal: AbortSignal.timeout(15_000)
    });
    if (!result || result.statusCode !== 200 || !result.stream) {
      const error = new Error(`Blob 객체를 찾지 못했습니다: ${id}/${filename}`);
      error.code = "ENOENT";
      throw error;
    }
    return streamToBuffer(result.stream);
  }

  async #speakerIds() {
    const ids = new Set();
    let cursor;
    do {
      const page = await this.client.list({
        prefix: `${this.prefix}/`,
        cursor,
        limit: 1_000,
        token: this.token,
        abortSignal: AbortSignal.timeout(15_000)
      });
      for (const blob of page.blobs || []) {
        const relative = blob.pathname.slice(this.prefix.length + 1);
        const [id, filename] = relative.split("/");
        if (id && filename === "speaker.json") ids.add(id);
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return [...ids];
  }

  async initialize() {
    if (this.initialized) return;
    const speakers = await this.list();
    for (const speaker of speakers) {
      if (speaker.encryption?.version !== 1) throw new Error(`암호화되지 않은 Blob 화자 프로필입니다: ${speaker.name}`);
      const profileFilename = speaker.storage?.profileFilename || "profile.bin.enc";
      const referenceFilename = speaker.storage?.referenceFilename || "reference.wav.enc";
      const [profile, reference] = await Promise.all([
        this.#read(speaker.id, profileFilename),
        this.#read(speaker.id, referenceFilename)
      ]);
      decryptBlob(profile, this.encryptionKey, `${speaker.id}:profile`);
      decryptBlob(reference, this.encryptionKey, `${speaker.id}:reference`);
    }
    this.initialized = true;
  }

  async list(organizationId = null) {
    const ids = await this.#speakerIds();
    const speakers = [];
    for (const id of ids) {
      try {
        const metadata = JSON.parse((await this.#read(id, "speaker.json")).toString("utf8"));
        if (!organizationId || metadata.organizationId === organizationId) {
          speakers.push({ ...metadata, encryptedAtRest: true });
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return speakers.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async save(metadata, profile, referenceWav) {
    const version = randomUUID();
    const profileFilename = `profile.${version}.bin.enc`;
    const referenceFilename = `reference.${version}.wav.enc`;
    const storedMetadata = {
      ...metadata,
      encryptedAtRest: true,
      encryption: { version: 1, algorithm: "AES-256-GCM" },
      storage: { provider: "vercel-blob", access: "private", version, profileFilename, referenceFilename }
    };
    const paths = [
      this.#pathname(metadata.id, profileFilename),
      this.#pathname(metadata.id, referenceFilename),
      this.#pathname(metadata.id, "speaker.json")
    ];
    const common = {
      access: "private",
      token: this.token,
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 60,
      abortSignal: AbortSignal.timeout(20_000)
    };
    const uploaded = [];
    try {
      await this.client.put(paths[0], encryptBlob(profile, this.encryptionKey, `${metadata.id}:profile`),
        { ...common, contentType: "application/octet-stream" });
      uploaded.push(paths[0]);
      await this.client.put(paths[1], encryptBlob(referenceWav, this.encryptionKey, `${metadata.id}:reference`),
        { ...common, contentType: "application/octet-stream" });
      uploaded.push(paths[1]);
      await this.client.put(paths[2], JSON.stringify(storedMetadata),
        { ...common, contentType: "application/json" });
      uploaded.push(paths[2]);
      return storedMetadata;
    } catch (error) {
      if (uploaded.length) await this.client.del(uploaded, { token: this.token }).catch(() => undefined);
      throw error;
    }
  }

  async replace(metadata, profile, referenceWav, organizationId) {
    const current = (await this.list(organizationId)).find(({ id }) => id === metadata.id);
    if (!current) return null;
    const version = randomUUID();
    const profileFilename = `profile.${version}.bin.enc`;
    const referenceFilename = `reference.${version}.wav.enc`;
    const storedMetadata = {
      ...metadata,
      encryptedAtRest: true,
      encryption: { version: 1, algorithm: "AES-256-GCM" },
      storage: { provider: "vercel-blob", access: "private", version, profileFilename, referenceFilename }
    };
    const payloadPaths = [
      this.#pathname(metadata.id, profileFilename),
      this.#pathname(metadata.id, referenceFilename)
    ];
    const common = {
      access: "private", token: this.token, addRandomSuffix: false, allowOverwrite: false,
      cacheControlMaxAge: 60, abortSignal: AbortSignal.timeout(20_000)
    };
    const uploaded = [];
    try {
      await this.client.put(payloadPaths[0], encryptBlob(profile, this.encryptionKey, `${metadata.id}:profile`),
        { ...common, contentType: "application/octet-stream" });
      uploaded.push(payloadPaths[0]);
      await this.client.put(payloadPaths[1], encryptBlob(referenceWav, this.encryptionKey, `${metadata.id}:reference`),
        { ...common, contentType: "application/octet-stream" });
      uploaded.push(payloadPaths[1]);
      await this.client.put(this.#pathname(metadata.id, "speaker.json"), JSON.stringify(storedMetadata),
        { ...common, allowOverwrite: true, contentType: "application/json" });
    } catch (error) {
      if (uploaded.length) await this.client.del(uploaded, { token: this.token }).catch(() => undefined);
      throw error;
    }
    const previousFiles = [current.storage?.profileFilename, current.storage?.referenceFilename]
      .filter(Boolean)
      .map((filename) => this.#pathname(metadata.id, filename));
    if (previousFiles.length) await this.client.del(previousFiles, { token: this.token }).catch(() => undefined);
    return storedMetadata;
  }

  async updateMetadata(id, organizationId, changes = {}) {
    const existing = (await this.list(organizationId)).find((speaker) => speaker.id === id);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...changes,
      id: existing.id,
      organizationId: existing.organizationId,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt,
      encryption: existing.encryption,
      storage: existing.storage,
      encryptedAtRest: true
    };
    await this.client.put(this.#pathname(id, "speaker.json"), JSON.stringify(updated), {
      access: "private", token: this.token, addRandomSuffix: false, allowOverwrite: true,
      cacheControlMaxAge: 60, contentType: "application/json", abortSignal: AbortSignal.timeout(20_000)
    });
    return updated;
  }

  async remove(id, organizationId = null) {
    if (organizationId) {
      const speakers = await this.list(organizationId);
      if (!speakers.some((speaker) => speaker.id === id)) return false;
    }
    const page = await this.client.list({
      prefix: `${this.prefix}/${id}/`, limit: 1_000, token: this.token,
      abortSignal: AbortSignal.timeout(15_000)
    });
    const paths = (page.blobs || []).map(({ pathname }) => pathname);
    if (paths.length) await this.client.del(paths, { token: this.token });
    return true;
  }

  async migrationPlan() {
    const speakers = await this.list();
    return speakers.map((speaker) => ({
      id: speaker.id,
      name: speaker.name,
      encrypted: true,
      plaintextFiles: []
    }));
  }

  async migratePlaintext({ commit = false } = {}) {
    return { committed: Boolean(commit), migrated: [], plan: await this.migrationPlan() };
  }

  async loadProfiles(organizationId = null) {
    const speakers = await this.list(organizationId);
    return Promise.all(speakers.map(async (speaker) => {
      const profileFilename = speaker.storage?.profileFilename || "profile.bin.enc";
      const referenceFilename = speaker.storage?.referenceFilename || "reference.wav.enc";
      const [profilePayload, referencePayload] = await Promise.all([
        this.#read(speaker.id, profileFilename),
        this.#read(speaker.id, referenceFilename)
      ]);
      const profileBuffer = decryptBlob(profilePayload, this.encryptionKey, `${speaker.id}:profile`);
      const referenceAudio = decryptBlob(referencePayload, this.encryptionKey, `${speaker.id}:reference`);
      const values = Float32Array.from(new Float32Array(Uint8Array.from(profileBuffer).buffer));
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
