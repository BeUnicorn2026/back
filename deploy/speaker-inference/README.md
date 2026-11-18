# ConThink speaker inference

Private, key-authenticated speaker embedding service for 16 kHz mono PCM16 audio.

The service keeps three shared sherpa-onnx extractors in memory, bounds the pending
request queue, and never persists submitted audio.

Endpoints:

- `GET /health`
- `POST /v1/embeddings` with `Authorization: Bearer ...` and
  `Content-Type: application/octet-stream`

Production uses the multilingual VoxBlink2 SimAM-ResNet100 speaker-verification
model. Its fixed 2-second ONNX input is handled by splitting longer requests and
averaging normalized embeddings. The response embedding format is model-specific;
users need to enroll again after any model or dimension change.
