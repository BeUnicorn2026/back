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
npm run test:live-stt -- ./sample.wav ko
```

Production:

```bash
npm ci --omit=dev
npm start
```
