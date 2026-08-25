# Go backend migration

The migration is incremental so active meeting capture and saved documents remain usable throughout the rewrite.

## Implemented in Go

- Bounded asynchronous work queue with graceful shutdown
- `POST /api/ai/meetmap/jobs`
- `GET /api/ai/meetmap/jobs/{id}`
- OpenRouter Chat Completions client using only `stealth/ox-alpha`, strict named JSON schemas, low reasoning effort, and one bounded retry for 429/5xx or invalid output
- Explicit deterministic local mode only when `OPENROUTER_API_KEY` is absent; configured-provider failures surface without local fallback
- MeetMap validation for topic chunks, dialogue tags, six-word summaries, unique transcript evidence, and one earlier parent per node
- Liveness, readiness, CORS, an absolute 1 MiB limit on every AI JSON POST body, and fail-closed bearer-token protection
- Tenant-scoped forwarding through the existing Node session and CSRF boundary
- A production Compose service that keeps the Go API private on the application network

Jobs are currently in memory. The Go service owns MeetMap inference, while Node remains the public compatibility entrypoint until the remaining routes are ported.

## Compatibility boundary still on Node

1. Sessions, email verification, organizations, and CSRF
2. Meeting, billing, and private knowledge persistence
3. Deepgram live WebSocket and file transcription
4. Encrypted voice-profile storage and speaker inference
5. Toss payment confirmation and deployment health dependencies

## Next migration order

1. Move PostgreSQL-backed session and meeting repositories behind Go interfaces.
2. Persist MeetMap jobs and attach completed results to saved meeting documents.
3. Proxy then replace live transcription WebSockets while preserving the current browser event contract.
4. Port billing, knowledge, and encrypted voice ownership endpoints.
5. Switch the production container only after parity tests pass against both runtimes.
