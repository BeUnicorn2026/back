#!/usr/bin/env python3
"""Idempotently configure the production backend's private speaker service."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path


UPDATES = {
    "SPEAKER_INFERENCE_ORIGIN": "http://127.0.0.1:8710",
    "SPEAKER_INFERENCE_TOKEN_FILE": "/home/dlwjdgns13579/Unicorn/config/speaker-inference.token",
    "SPEAKER_INFERENCE_MODEL_ID": "wespeaker/voxblink2-simam-resnet100",
    "SPEAKER_INFERENCE_DIMENSIONS": "256",
    "SPEAKER_MATCH_THRESHOLD": "0.45",
    "SPEAKER_MATCH_MARGIN": "0.05",
}


def main() -> None:
    path = Path(sys.argv[1])
    lines = path.read_text(encoding="utf-8").splitlines()
    seen: set[str] = set()
    output: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line and not line.lstrip().startswith("#") else ""
        if key in UPDATES:
            if key not in seen:
                output.append(f"{key}={UPDATES[key]}")
                seen.add(key)
        else:
            output.append(line)
    for key, value in UPDATES.items():
        if key not in seen:
            output.append(f"{key}={value}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
            temporary.write("\n".join(output) + "\n")
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


if __name__ == "__main__":
    main()
