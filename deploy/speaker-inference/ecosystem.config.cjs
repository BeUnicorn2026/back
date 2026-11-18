module.exports = {
  apps: [{
    name: "conthink-speaker-inference",
    script: ".venv/bin/python",
    args: "server.py --host 0.0.0.0 --port 8710",
    cwd: __dirname,
    interpreter: "none",
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    env: {
      SPEAKER_MODEL_PATH: "models/simam-resnet100-sherpa.onnx",
      SPEAKER_FIXED_WINDOW_SECONDS: "2",
      SPEAKER_WORKERS: "3",
      SPEAKER_THREADS: "2",
      SPEAKER_MAX_PENDING: "24"
    }
  }]
};
