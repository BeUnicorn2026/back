# Voice Partition Backend

## Go migration server

The Go server currently owns the asynchronous MeetMap pipeline while the existing Node server remains the compatibility runtime for auth, billing, STT, WebSocket audio, and persistence.

```bash
cp .env.example .env
AI_API_TOKEN=local-development-token npm run go:dev
```

`OPENROUTER_API_KEY` is optional. Without it, jobs use the deterministic local MeetMap analyzer. Once it is set, the default model is `stealth/ox-alpha` through OpenRouter. Keep the key server-side and review the model provider's data-retention terms before sending private meeting transcripts.

```bash
curl -X POST http://127.0.0.1:7071/api/ai/meetmap/jobs \
  -H 'Authorization: Bearer local-development-token' \
  -H 'Content-Type: application/json' \
  -d '{"meetingId":"demo","segments":[{"speaker":"민수","start":0,"end":2,"text":"어떻게 시작할까요?"}]}'
```

Poll the path returned in the `Location` header until the job status is `succeeded` or `failed`.

```bash
npm run go:test
```

See [`docs/go-migration.md`](docs/go-migration.md) for the compatibility boundary and migration order.

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
