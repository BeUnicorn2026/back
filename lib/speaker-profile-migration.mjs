function profileBuffer(vectors) {
  return Buffer.concat(vectors.map((vector) =>
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)));
}

export function speakerProfileNeedsMigration(speaker, modelInfo) {
  if (!speaker || !modelInfo) return true;
  if (speaker.model !== modelInfo.id) return true;
  if (Number(speaker.profileDimensions) !== Number(modelInfo.dimensions)) return true;
  return !Array.isArray(speaker.profiles)
    || !speaker.profiles.length
    || speaker.profiles.some((profile) => profile.length !== modelInfo.dimensions);
}

export async function migrateSpeakerProfiles(speakers, options) {
  const migrated = [];
  for (const speaker of Array.isArray(speakers) ? speakers : []) {
    if (!speakerProfileNeedsMigration(speaker, options.modelInfo)) continue;
    if (!Buffer.isBuffer(speaker.referenceAudio) || !speaker.referenceAudio.length) {
      throw new Error(`${speaker.name}: 기존 등록 음성 원본이 없어 화자 모델을 갱신할 수 없습니다.`);
    }
    const pcm = await options.decodeReference(speaker.referenceAudio);
    const profile = await options.model.createProfile(pcm);
    const vectors = [profile.centroid, ...profile.exemplars];
    const metadata = {
      ...speaker,
      model: options.modelInfo.id,
      profileCount: vectors.length,
      profileDimensions: options.modelInfo.dimensions,
      enrollmentConsistency: profile.consistency,
      matchThreshold: profile.matchThreshold,
      modelMigratedAt: new Date().toISOString(),
      migratedFromModel: speaker.model || "unknown"
    };
    delete metadata.profile;
    delete metadata.profiles;
    delete metadata.referenceAudio;
    await options.replace(metadata, profileBuffer(vectors), speaker.referenceAudio);
    migrated.push({ id: speaker.id, name: speaker.name, from: speaker.model || "unknown", to: options.modelInfo.id });
  }
  return migrated;
}
