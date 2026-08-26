import WebSocket from "ws";
import { analyzePcmQuality, isSpeakerInferenceQuality, isSpeakerSignalQuality } from "./audio-quality.mjs";
import { canForwardLiveAudio } from "./live-audio-backpressure.mjs";
import { createDeepgramKeepAlive, deepgramApplicationError, parseDeepgramLiveEvent } from "./deepgram-live-connection.mjs";
import { buildDeepgramLiveQuery } from "./deepgram-live-options.mjs";
import { diarizedAudioRegions, wordsToTranscriptSegments } from "./speaker-matching.mjs";
import { speakerRegionSampleRange } from "./live-speaker-regions.mjs";
import { PcmHistoryBuffer } from "./pcm-history-buffer.mjs";
import { SpeakerAudioAccumulator } from "./speaker-audio-accumulator.mjs";
import { createSelfTranscriptQuarantine } from "./self-transcript-quarantine.mjs";

function sendJson(client, payload, callback) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload), callback);
}

export function alignRoomSegmentsToMeetingTimeline(segments, meetingStartedAt, streamStartedAt = Date.now()) {
  const meetingStartMs = Date.parse(String(meetingStartedAt || ""));
  const streamStartMs = streamStartedAt instanceof Date
    ? streamStartedAt.getTime()
    : Number(streamStartedAt);
  if (!Number.isFinite(meetingStartMs) || !Number.isFinite(streamStartMs)) {
    return (Array.isArray(segments) ? segments : []).map((segment) => ({ ...segment }));
  }
  const offsetSeconds = Math.max(0, (streamStartMs - meetingStartMs) / 1_000);
  return (Array.isArray(segments) ? segments : []).map((segment) => ({
    ...segment,
    start: offsetSeconds + Math.max(0, Number(segment?.start) || 0),
    end: offsetSeconds + Math.max(Number(segment?.start) || 0, Number(segment?.end) || Number(segment?.start) || 0)
  }));
}

/**
 * Runs the privacy-preserving room live path. Authentication, room membership,
 * canonical profile resolution, and meeting binding must be completed before
 * this function is called, so no provider connection can precede authorization.
 */
export async function handleSelfOnlyRoomLive(options) {
  const {
    client,
    requestUrl,
    auth,
    room,
    meeting,
    canonicalProfile,
    meetingStore,
    prepareSpeakerModel,
    speakerRecognitionEnabled = true,
    speakerModelInfo,
    speakerInferenceInfo,
    sampleRate = 16_000,
    maximumAudioBytes = Number.POSITIVE_INFINITY,
    deepgramApiKey,
    hubConnection,
    createProvider = (url, providerOptions) => new WebSocket(url, providerOptions)
  } = options;

  let provider;
  let keepAlive;
  let finalizeFallback;
  let finalizationRequested = false;
  let finalized = false;
  let transcriptQueue = Promise.resolve();
  let streamStartedAt = Date.now();
  const recognitionSampleRate = speakerRecognitionEnabled ? speakerModelInfo.sampleRate : sampleRate;
  const quarantine = speakerRecognitionEnabled ? createSelfTranscriptQuarantine(canonicalProfile) : null;
  const audioHistory = speakerRecognitionEnabled ? new PcmHistoryBuffer(recognitionSampleRate * 90) : null;
  const accumulator = speakerRecognitionEnabled ? new SpeakerAudioAccumulator({
    sampleRate: recognitionSampleRate,
    minimumSeconds: speakerInferenceInfo.windowSeconds
  }) : null;
  const analyzedRegions = speakerRecognitionEnabled ? new Set() : null;
  const seenSttFinals = new Set();
  let forwardedAudioBytes = 0;

  const closeResources = () => {
    clearTimeout(finalizeFallback);
    quarantine?.close();
    if (audioHistory) {
      audioHistory.chunks.length = 0;
      audioHistory.totalSamples = 0;
    }
    accumulator?.clusters.clear();
    analyzedRegions?.clear();
    seenSttFinals.clear();
    hubConnection.release().catch(() => undefined);
    keepAlive?.stop();
    if (provider?.readyState === WebSocket.OPEN) {
      provider.send(JSON.stringify({ type: "CloseStream" }));
      provider.close();
    }
  };
  client.once("close", closeResources);

  try {
    // 화자 인식 품질을 다시 검증할 때까지 모델 로드는 비활성화한다.
    // const model = await prepareSpeakerModel();
    const model = speakerRecognitionEnabled ? await prepareSpeakerModel() : null;

    const releaseAccepted = async (segments) => {
      const alignedSegments = alignRoomSegmentsToMeetingTimeline(segments, meeting.startedAt, streamStartedAt);
      for (const segment of alignedSegments) {
        await hubConnection.acceptFinalSegment(segment, (candidate) =>
          meetingStore.appendAcceptedSegment(meeting.id, auth.organization.id, candidate));
      }
    };

    const analyzeDiarizedRegions = async (words) => {
      const released = [];
      for (const region of diarizedAudioRegions(words, { minimumDuration: 0.2 })) {
        const cacheKey = `${region.sourceSpeaker}:${region.start.toFixed(2)}:${region.end.toFixed(2)}`;
        if (analyzedRegions.has(cacheKey)) continue;
        const range = speakerRegionSampleRange(region, audioHistory, recognitionSampleRate);
        if (!range) continue;
        const snapshot = audioHistory.slice(range.firstSample, range.lastSample);
        const pcm = new Int16Array(snapshot.buffer, snapshot.byteOffset, Math.floor(snapshot.byteLength / 2));
        const signalQuality = analyzePcmQuality(pcm, recognitionSampleRate);
        if (!isSpeakerSignalQuality(signalQuality)) continue;
        analyzedRegions.add(cacheKey);
        const accumulated = accumulator.add(region.sourceSpeaker, pcm, region);
        if (!accumulated) continue;
        const inferenceQuality = analyzePcmQuality(accumulated.pcm, recognitionSampleRate);
        if (!isSpeakerInferenceQuality(inferenceQuality)) continue;
        const scores = await model.compare(accumulated.pcm, [canonicalProfile.profiles], {
          maximumEmbeddings: speakerInferenceInfo.realtimeMaximumEmbeddings
        });
        if (!scores) continue;
        released.push(...quarantine.updateEvidence(region.sourceSpeaker, scores, {
          threshold: Number(process.env.SPEAKER_MATCH_THRESHOLD) || speakerModelInfo.defaultMatchThreshold,
          margin: Number(process.env.SPEAKER_MATCH_MARGIN) || speakerModelInfo.defaultMatchMargin
        }));
      }
      return released;
    };

    const language = requestUrl.searchParams.get("language");
    const query = buildDeepgramLiveQuery({
      language,
      mode: speakerRecognitionEnabled ? "speaker" : "stt",
      keyterms: speakerRecognitionEnabled ? [canonicalProfile.displayName] : [],
      sampleRate: recognitionSampleRate
    });
    provider = createProvider(`wss://api.deepgram.com/v1/listen?${query}`, {
      headers: { Authorization: `Token ${deepgramApiKey}` }
    });

    provider.on("open", () => {
      streamStartedAt = Date.now();
      keepAlive = createDeepgramKeepAlive(provider);
      sendJson(client, {
        type: "ready",
        mode: "self",
        roomId: room.id,
        meetingId: meeting.id,
        sampleRate: recognitionSampleRate,
        speaker: {
          userId: canonicalProfile.userId,
          speakerProfileId: canonicalProfile.speakerProfileId,
          displayName: canonicalProfile.displayName
        }
      });
    });

    const acknowledgeFinalization = () => {
      if (finalized) return;
      finalized = true;
      clearTimeout(finalizeFallback);
      transcriptQueue.finally(async () => {
        sendJson(client, { type: "finalized", meetingId: meeting.id });
      });
    };

    provider.on("message", (raw) => {
      const parsed = parseDeepgramLiveEvent(raw);
      if (!parsed.ok) {
        sendJson(client, { type: "error", code: "PROVIDER_RESPONSE_INVALID", message: "실시간 STT 응답을 처리하지 못했습니다." },
          () => provider.readyState === WebSocket.OPEN && provider.close(1002, "invalid provider response"));
        return;
      }
      const event = parsed.event;
      const providerError = deepgramApplicationError(event);
      if (providerError) {
        sendJson(client, { type: "error", code: providerError.code, message: providerError.message },
          () => provider.readyState === WebSocket.OPEN && provider.close(1011, "provider error"));
        return;
      }
      if (event.type !== "Results") return;
      const alternative = event.channel?.alternatives?.[0];
      if (event.is_final && alternative?.words?.length) {
        transcriptQueue = transcriptQueue.then(async () => {
          if (!speakerRecognitionEnabled) {
            const finalKey = JSON.stringify(alternative.words.map((word) => [
              word?.speaker ?? word?.sourceSpeaker ?? null,
              Number(word?.start) || 0,
              Number(word?.end) || Number(word?.start) || 0,
              String(word?.punctuated_word ?? word?.word ?? "").trim()
            ]));
            if (seenSttFinals.has(finalKey)) return;
            seenSttFinals.add(finalKey);
            const segments = wordsToTranscriptSegments(alternative.words).map((segment) => ({
              ...segment,
              userId: canonicalProfile.userId ?? canonicalProfile.createdBy,
              speakerProfileId: canonicalProfile.speakerProfileId ?? canonicalProfile.id,
              displayName: canonicalProfile.displayName,
              speaker: canonicalProfile.displayName,
              known: true,
              confidence: null
            }));
            await releaseAccepted(segments);
            return;
          }
          const hasDiarization = alternative.words.every(({ speaker }) =>
            speaker != null && speaker !== "" && Number.isInteger(Number(speaker)) && Number(speaker) >= 0);
          if (!hasDiarization) return;
          const released = quarantine.ingestFinal({
            isFinal: true,
            providerFinalId: event.metadata?.request_id ?? event.id,
            words: alternative.words,
            receivedAt: Date.now()
          });
          released.push(...await analyzeDiarizedRegions(alternative.words));
          await releaseAccepted(released);
        }).catch(() => {
          sendJson(client, { type: "error", code: "ROOM_TRANSCRIPT_PROCESSING_FAILED", message: "실시간 화자 분석을 처리하지 못했습니다." });
        });
      }
      if (event.from_finalize && finalizationRequested) acknowledgeFinalization();
    });

    provider.on("error", () => {
      sendJson(client, { type: "error", code: "PROVIDER_CONNECTION_FAILED", message: "실시간 STT 연결을 유지하지 못했습니다." });
    });
    provider.on("close", () => {
      keepAlive?.stop();
      if (client.readyState === WebSocket.OPEN) client.close(1011, "STT connection closed");
    });

    client.on("message", (data, isBinary) => {
      if (provider.readyState !== WebSocket.OPEN) return;
      if (!isBinary) {
        try {
          const control = JSON.parse(data.toString());
          if (control.type === "finalize" && !finalizationRequested) {
            if (control.meetingId && String(control.meetingId) !== meeting.id) {
              sendJson(client, { type: "error", code: "ROOM_MEETING_MISMATCH", message: "다른 회의 ID를 사용할 수 없습니다." },
                () => client.close(1008, "meeting mismatch"));
              return;
            }
            finalizationRequested = true;
            provider.send(JSON.stringify({ type: "Finalize" }));
            finalizeFallback = setTimeout(acknowledgeFinalization, 3_500);
          } else if (control.type === "speakerCorrection") {
            sendJson(client, { type: "error", code: "SPEAKER_CORRECTION_DISABLED", message: "방 모드에서는 화자 수정을 지원하지 않습니다." });
          }
        } catch {
          // Malformed control data has no transcript and is ignored.
        }
        return;
      }

      if (finalizationRequested || finalized) {
        sendJson(client, { type: "error", code: "ROOM_STREAM_FINALIZED", message: "종료된 연결에는 음성을 추가할 수 없습니다." });
        return;
      }
      const incoming = Buffer.from(data);
      if (forwardedAudioBytes + incoming.length > maximumAudioBytes) {
        sendJson(client, { type: "error", code: "PLAN_DURATION_LIMIT", message: "회의당 최대 녹음 시간에 도달했습니다." },
          () => provider.readyState === WebSocket.OPEN && provider.close(1000, "plan duration reached"));
        return;
      }
      if (!canForwardLiveAudio(provider)) {
        sendJson(client, { type: "error", code: "AUDIO_BACKPRESSURE", message: "STT 전송이 지연되어 연결을 종료합니다." },
          () => provider.readyState === WebSocket.OPEN && provider.close(1011, "audio backpressure"));
        return;
      }
      provider.send(incoming);
      forwardedAudioBytes += incoming.length;
      keepAlive?.markAudioForwarded();
      audioHistory?.append(incoming);
    });
  } catch (error) {
    closeResources();
    throw error;
  }
}
