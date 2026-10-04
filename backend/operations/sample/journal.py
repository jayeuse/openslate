"""Durable owner-only sample evidence; never receives HTTP bodies or cookies."""

import json
import os
import stat
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path


def append_event(path: Path, values: Mapping[str, object]) -> None:
    entry = {"timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"), **values}
    encoded = (json.dumps(entry, sort_keys=True, separators=(",", ":")) + "\n").encode()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OSError("journal is not a regular file")
        os.fchmod(descriptor, 0o600)
        remaining = memoryview(encoded)
        while remaining:
            written = os.write(descriptor, remaining)
            if written <= 0:
                raise OSError("short journal write")
            remaining = remaining[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
