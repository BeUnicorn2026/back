# Voice Partition Backend

```bash
npm install
cp .env.example .env
npm run dev
```

For a separate production frontend origin:

```bash
PUBLIC_ORIGIN=https://app.example.com SESSION_COOKIE_SAME_SITE=none npm start
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
