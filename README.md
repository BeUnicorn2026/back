# Voice Partition Backend

```bash
npm install
cp .env.example .env
npm run dev
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
