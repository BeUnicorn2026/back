# Voice Partition Backend

## Go migration server

The Go server owns the asynchronous MeetMap pipeline while the existing Node server remains the public compatibility runtime for auth, billing, STT, WebSocket audio, and persistence. In Compose, Node forwards authenticated MeetMap requests to the private Go service.

```bash
cp .env.example .env
AI_API_TOKEN=local-development-token npm run go:dev
```

`OPENROUTER_API_KEY` is optional. Without it, the Go AI paths run in explicit deterministic local mode. Once it is set, the default and only configured model is `stealth/ox-alpha` through OpenRouter; exhausted provider errors surface instead of silently falling back locally. Requests use strict named JSON schemas, low reasoning effort, and one bounded retry for 429/5xx or invalid provider output. Keep the key server-side and review the model provider's data-retention terms before sending private meeting transcripts. `AI_MAXIMUM_BODY_BYTES` may lower the AI JSON POST limit but cannot raise its absolute 1 MiB cap.

```bash
curl -X POST http://127.0.0.1:7071/api/ai/meetmap/jobs \
  -H 'Authorization: Bearer local-development-token' \
  -H 'X-Voice-Partition-Tenant: local:developer' \
  -H 'Content-Type: application/json' \
  -d '{"meetingId":"demo","segments":[{"speaker":"민수","start":0,"end":2,"text":"어떻게 시작할까요?"}]}'
```

Poll the path returned in the `Location` header until the job status is `succeeded` or `failed`.

```bash
npm run go:test
```

See [`docs/go-migration.md`](docs/go-migration.md) for the compatibility boundary and migration order. For the `front/` + `back/` deployment, this directory's [`compose.yaml`](compose.yaml) is authoritative: it starts both Node and the private Go AI service and wires `GO_AI_ORIGIN` to the internal service address.

## 실시간 라이브맵(Live Map)

Live Map merges finalized speech from the same speaker when the gap is under 1.25 seconds, then uses a Go session to run OpenRouter call A (turn to nodes/topic) and call B (node to parent link). It returns deltas and state over the existing live WebSocket and, on meeting finalization, stores the tree at `meeting_intelligence.result_json.meetMap` with `origin: "livemap"`. A later batch MeetMap result may overwrite it (last write wins).

All three conditions are required to enable it:

- Set `LIVEMAP_ENABLED` to the exact string `true` (the default is `false`).
- Set `GO_AI_ORIGIN` to an address reachable from Node.
- Set the same `AI_API_TOKEN` for Node and Go. `LIVEMAP_MODEL` is optional and falls back to `OPENROUTER_MODEL` when empty.

Internal, bearer-protected, tenant-scoped session endpoints live under `/api/ai/livemap/...`. If Go is unavailable or misconfigured, live captions remain completely unaffected; the live map is simply absent. Session state is held in Go process memory, so a Go restart loses the active live session, but running the batch MeetMap after the meeting can rebuild the tree.

> **PRIVACY AND EXTERNAL-TRANSMISSION WARNING:** With `LIVEMAP_ENABLED=true`, **every finalized speech turn is transmitted to OpenRouter in real time during the meeting** and incurs per-turn usage costs. This integration provides no guaranteed no-retention setting. Do not enable it for meetings whose content must not leave your infrastructure.

## 자기소개 기반 발화 번역

`OPENAI_API_KEY`가 설정되면 인증된 사용자의 프런트엔드는 확정된 발화 순서를 `/api/transcript/translations`에 요청합니다. 서버는 클라이언트가 보낸 임의 문장이 아니라 접근 권한이 확인된 회의 저장 원문과 현재 로그인 사용자의 서버 저장 자기소개만 사용합니다. 결과와 캐시는 사용자별로 분리되므로 같은 `DB` 발화도 디자이너와 백엔드 개발자에게 서로 다른 눈높이로 표시될 수 있습니다. 원문은 회의 기록에 그대로 보존됩니다.

> **개인정보 및 외부 전송 주의:** 이 기능은 각 확정 발화와 요청 사용자의 자기소개를 OpenAI에 자동 전송합니다. `store: false`로 요청하지만, 사용 전 조직의 개인정보·보존 정책과 OpenAI 데이터 처리 조건을 검토해야 합니다. `OPENAI_API_KEY`가 없으면 서버는 원문을 반환합니다.

## Node compatibility server

```bash
npm install
cp .env.example .env
npm run dev
```

For production, set the exact frontend origin. Cross-origin production sessions automatically use a secure `SameSite=None` cookie:

```bash
PUBLIC_ORIGIN=https://app.example.com npm start
```

```bash
npm test
STT_TEST_EMAIL=user@example.com STT_TEST_PASSWORD=password npm run test:live-stt -- ./sample.wav
STT_TEST_EMAIL=user@example.com STT_TEST_PASSWORD=password STT_TEST_MODE=speaker STT_EXPECTED_SPEAKER='홍길동' npm run test:live-stt -- ./sample.wav
```

Production:

```bash
npm ci --omit=dev
npm start
```
