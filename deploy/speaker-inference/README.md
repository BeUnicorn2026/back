# ConThink speaker inference

Private, key-authenticated speaker embedding service for 16 kHz mono PCM16 audio.

The service keeps three shared sherpa-onnx extractors in memory, bounds the pending
request queue, and never persists submitted audio.

Endpoints:

- `GET /health`
- `POST /v1/embeddings` with `Authorization: Bearer ...` and
  `Content-Type: application/octet-stream`

The response embedding format is model-specific. Existing WeSpeaker profiles must
not be compared with 3D-Speaker embeddings; users need to enroll again after the
backend switches models.
