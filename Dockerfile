FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=7070 \
    VOICE_PARTITION_DATA_DIR=/app/.data

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs ./server.mjs
COPY lib ./lib
COPY scripts ./scripts
RUN mkdir -p /app/.data /app/.cache/speaker-models && chown -R node:node /app

USER node
EXPOSE 7070
VOLUME ["/app/.data", "/app/.cache/speaker-models"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7070/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
