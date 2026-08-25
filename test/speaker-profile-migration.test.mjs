import assert from "node:assert/strict";
import test from "node:test";
import { migrateSpeakerProfiles, speakerProfileNeedsMigration } from "../lib/speaker-profile-migration.mjs";

const modelInfo = { id: "new-model", dimensions: 2 };

test("recognizes current and stale speaker profiles", () => {
  assert.equal(speakerProfileNeedsMigration({
    model: "new-model", profileDimensions: 2, profiles: [new Float32Array([1, 0])]
  }, modelInfo), false);
  assert.equal(speakerProfileNeedsMigration({
    model: "old-model", profileDimensions: 2, profiles: [new Float32Array([1, 0])]
  }, modelInfo), true);
  assert.equal(speakerProfileNeedsMigration({
    model: "new-model", profileDimensions: 512, profiles: [new Float32Array(512)]
  }, modelInfo), true);
});

test("rebuilds stale profiles from encrypted-store reference audio without changing identity", async () => {
  const replacements = [];
  const speaker = {
    id: "speaker-one", name: "민수", organizationId: "org", model: "old-model",
    profileDimensions: 512, profiles: [new Float32Array(512)], referenceAudio: Buffer.from("wave")
  };
  const migrated = await migrateSpeakerProfiles([speaker], {
    modelInfo,
    decodeReference: async (reference) => {
      assert.deepEqual(reference, Buffer.from("wave"));
      return new Int16Array(16_000);
    },
    model: {
      createProfile: async () => ({
        centroid: new Float32Array([1, 0]),
        exemplars: [new Float32Array([0.9, 0.1])],
        consistency: 0.91,
        matchThreshold: 0.86
      })
    },
    replace: async (...argumentsList) => replacements.push(argumentsList)
  });
  assert.deepEqual(migrated, [{ id: "speaker-one", name: "민수", from: "old-model", to: "new-model" }]);
  assert.equal(replacements.length, 1);
  const [metadata, buffer, reference] = replacements[0];
  assert.equal(metadata.id, speaker.id);
  assert.equal(metadata.model, "new-model");
  assert.equal(metadata.profileDimensions, 2);
  assert.equal(metadata.profileCount, 2);
  assert.equal(buffer.byteLength, 2 * 2 * Float32Array.BYTES_PER_ELEMENT);
  assert.deepEqual(reference, speaker.referenceAudio);
  assert.equal("profiles" in metadata, false);
  assert.equal("referenceAudio" in metadata, false);
});

test("fails safely when a legacy profile has no reference audio", async () => {
  await assert.rejects(migrateSpeakerProfiles([{
    id: "speaker-one", name: "민수", model: "old-model", profiles: [new Float32Array(512)]
  }], { modelInfo }), /원본이 없어/);
});
