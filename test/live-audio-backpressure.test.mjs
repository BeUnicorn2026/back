import assert from "node:assert/strict";
import test from "node:test";
import { canForwardLiveAudio, maximumBufferedAudioBytes } from "../lib/live-audio-backpressure.mjs";

test("bounds provider buffering to five seconds of 16 kHz mono PCM", () => {
  assert.equal(maximumBufferedAudioBytes, 160_000);
  assert.equal(canForwardLiveAudio({ readyState: 1, bufferedAmount: maximumBufferedAudioBytes }), true);
  assert.equal(canForwardLiveAudio({ readyState: 1, bufferedAmount: maximumBufferedAudioBytes + 1 }), false);
  assert.equal(canForwardLiveAudio({ readyState: 0, bufferedAmount: 0 }), false);
});
