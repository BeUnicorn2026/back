#!/usr/bin/env sh
set -eu

export PATH="/home/dlwjdgns13579/.local/node/bin:$PATH"
cd /home/dlwjdgns13579/conthink-speaker-inference

if ! pm2 describe conthink-speaker-inference >/dev/null 2>&1; then
  pm2 start ecosystem.config.cjs
  pm2 save --force
fi

curl -fsS http://127.0.0.1:8710/health >/dev/null
