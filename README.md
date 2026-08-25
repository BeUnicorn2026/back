# Voice Partition Backend

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
