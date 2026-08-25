# Go backend migration

The migration is incremental so active meeting capture and saved documents remain usable throughout the rewrite.

## Implemented in Go

- Bounded asynchronous work queue with graceful shutdown
- `POST /api/ai/meetmap/jobs`
- `GET /api/ai/meetmap/jobs/{id}`
- OpenRouter Chat Completions client using `stealth/ox-alpha`
- Deterministic local fallback when `OPENROUTER_API_KEY` is absent
- MeetMap validation for topic chunks, dialogue tags, six-word summaries, unique transcript evidence, and one earlier parent per node
- Liveness, readiness, CORS, request-size limits, and optional bearer-token protection

Jobs are currently in memory. This server is not yet the production entrypoint.

## Compatibility boundary still on Node

1. Sessions, email verification, organizations, and CSRF
2. Meeting, billing, and private knowledge persistence
3. Deepgram live WebSocket and file transcription
4. Encrypted voice-profile storage and speaker inference
5. Toss payment confirmation and deployment health dependencies

## Next migration order

1. Move PostgreSQL-backed session and meeting repositories behind Go interfaces.
2. Persist MeetMap jobs and expose them through the existing meeting-intelligence route.
3. Proxy then replace live transcription WebSockets while preserving the current browser event contract.
4. Port billing, knowledge, and encrypted voice ownership endpoints.
5. Switch the production container only after parity tests pass against both runtimes.
