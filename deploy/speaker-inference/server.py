#!/usr/bin/env python3
"""Private sherpa-onnx speaker embedding HTTP service.

Accepts raw 16 kHz mono PCM16 audio and returns a normalized speaker embedding.
Audio is processed in memory and is never written to disk.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import queue
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx


SAMPLE_RATE = 16_000
MIN_AUDIO_BYTES = SAMPLE_RATE * 2
MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 15


class EmbeddingPool:
    def __init__(
        self,
        model_path: str,
        workers: int,
        threads_per_worker: int,
        fixed_window_seconds: float,
    ) -> None:
        self.model_path = model_path
        self.workers = max(1, workers)
        self.fixed_window_samples = max(0, round(fixed_window_seconds * SAMPLE_RATE))
        self._pool: queue.Queue[sherpa_onnx.SpeakerEmbeddingExtractor] = queue.Queue()
        for _ in range(self.workers):
            config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=model_path,
                num_threads=max(1, threads_per_worker),
                provider="cpu",
            )
            if not config.validate():
                raise RuntimeError(f"Invalid speaker embedding model: {model_path}")
            self._pool.put(sherpa_onnx.SpeakerEmbeddingExtractor(config))
        extractor = self._pool.get()
        self.dimensions = extractor.dim
        self._pool.put(extractor)

    def _windows(self, pcm: np.ndarray) -> list[np.ndarray]:
        if not self.fixed_window_samples:
            return [pcm]
        size = self.fixed_window_samples
        if pcm.size < size:
            return [np.pad(pcm, (0, size - pcm.size))]
        starts = list(range(0, pcm.size - size + 1, size))
        if starts[-1] != pcm.size - size:
            starts.append(pcm.size - size)
        return [pcm[start : start + size] for start in starts]

    def embed(self, pcm_bytes: bytes) -> list[float]:
        pcm = np.frombuffer(pcm_bytes, dtype="<i2").astype(np.float32) / 32768.0
        extractor = self._pool.get()
        try:
            embeddings = []
            for window in self._windows(pcm):
                stream = extractor.create_stream()
                stream.accept_waveform(sample_rate=SAMPLE_RATE, waveform=window)
                stream.input_finished()
                vector = np.asarray(extractor.compute(stream), dtype=np.float32)
                vector_norm = float(np.linalg.norm(vector))
                if not vector.size or not np.isfinite(vector_norm) or vector_norm <= 0:
                    raise RuntimeError("Speaker model returned an invalid embedding")
                embeddings.append(vector / vector_norm)
            embedding = np.mean(embeddings, axis=0)
        finally:
            self._pool.put(extractor)
        norm = float(np.linalg.norm(embedding))
        if not embedding.size or not np.isfinite(norm) or norm <= 0:
            raise RuntimeError("Speaker model returned an invalid embedding")
        return (embedding / norm).tolist()


class SpeakerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, *, token: str, model: EmbeddingPool, max_pending: int) -> None:
        super().__init__(address, handler)
        self.token = token
        self.model = model
        self.pending = threading.BoundedSemaphore(max(1, max_pending))
        self.started_at = time.time()


class Handler(BaseHTTPRequestHandler):
    server: SpeakerServer

    def log_message(self, message: str, *args) -> None:
        print(f"{self.address_string()} - {message % args}", flush=True)

    def send_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.token}"
        return hmac.compare_digest(supplied, expected)

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        self.send_json(HTTPStatus.OK, {
            "status": "ok",
            "model": os.path.basename(self.server.model.model_path),
            "sampleRate": SAMPLE_RATE,
            "dimensions": self.server.model.dimensions,
            "workers": self.server.model.workers,
            "fixedWindowSeconds": self.server.model.fixed_window_samples / SAMPLE_RATE,
            "uptimeSeconds": round(time.time() - self.server.started_at),
        })

    def do_POST(self) -> None:
        if self.path != "/v1/embeddings":
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self.authorized():
            self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        if self.headers.get_content_type() != "application/octet-stream":
            self.send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "raw_pcm16_required"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length < MIN_AUDIO_BYTES or content_length > MAX_AUDIO_BYTES or content_length % 2:
            self.send_json(HTTPStatus.BAD_REQUEST, {
                "error": "audio_length_invalid",
                "minimumSeconds": 1,
                "maximumSeconds": 15,
            })
            return
        if not self.server.pending.acquire(blocking=False):
            self.send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "inference_queue_full"})
            return
        try:
            pcm = self.rfile.read(content_length)
            if len(pcm) != content_length:
                self.send_json(HTTPStatus.BAD_REQUEST, {"error": "audio_body_incomplete"})
                return
            started_at = time.perf_counter()
            embedding = self.server.model.embed(pcm)
            self.send_json(HTTPStatus.OK, {
                "embedding": embedding,
                "dimensions": len(embedding),
                "durationSeconds": content_length / 2 / SAMPLE_RATE,
                "inferenceMilliseconds": round((time.perf_counter() - started_at) * 1000, 2),
            })
        except Exception as error:
            self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {
                "error": "inference_failed",
                "message": str(error),
            })
        finally:
            self.server.pending.release()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.getenv("SPEAKER_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("SPEAKER_PORT", "8710")))
    parser.add_argument("--model", default=os.getenv("SPEAKER_MODEL_PATH", "models/3dspeaker.onnx"))
    parser.add_argument("--workers", type=int, default=int(os.getenv("SPEAKER_WORKERS", "3")))
    parser.add_argument("--threads", type=int, default=int(os.getenv("SPEAKER_THREADS", "2")))
    parser.add_argument("--max-pending", type=int, default=int(os.getenv("SPEAKER_MAX_PENDING", "24")))
    parser.add_argument(
        "--fixed-window-seconds",
        type=float,
        default=float(os.getenv("SPEAKER_FIXED_WINDOW_SECONDS", "0")),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    token = os.getenv("SPEAKER_API_TOKEN", "")
    if not token:
        token_path = os.getenv("SPEAKER_API_TOKEN_FILE", ".speaker-api-token")
        try:
            with open(token_path, encoding="utf-8") as token_file:
                token = token_file.read().strip()
        except FileNotFoundError:
            pass
    if len(token) < 32:
        raise RuntimeError("SPEAKER_API_TOKEN or SPEAKER_API_TOKEN_FILE must contain at least 32 characters")
    model = EmbeddingPool(args.model, args.workers, args.threads, args.fixed_window_seconds)
    server = SpeakerServer(
        (args.host, args.port),
        Handler,
        token=token,
        model=model,
        max_pending=args.max_pending,
    )
    print(
        f"speaker inference ready on {args.host}:{args.port} "
        f"with {model.workers} workers and {model.dimensions} dimensions",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
