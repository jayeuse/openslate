"""Bound DNS/network/parsing as one optional effect, without passing application credentials."""

import json
import os
import subprocess
import sys
from pathlib import Path
from time import monotonic

from app.systems.comms.previews.metadata import validated
from app.systems.comms.previews.urls import target

clock = monotonic
CHILD_MODULE = "app.systems.comms.previews.child"
MAX_OUTPUT = 32768


def fetch_bounded(url: str) -> dict[str, str] | None:
    deadline = clock() + 5
    value = target(url)
    if value is None:
        return None
    budget = deadline - clock()
    if budget <= 0:
        return None
    try:
        result = subprocess.run(
            [sys.executable, "-m", CHILD_MODULE, str(deadline)],
            input=json.dumps({"url": value.url}, ensure_ascii=False).encode(),
            env={"PATH": os.defpath, "PYTHONNOUSERSITE": "1"},
            cwd=Path(__file__).resolve().parents[4],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=budget,
            check=False,
        )
        if result.returncode != 0 or len(result.stdout) > MAX_OUTPUT or clock() > deadline:
            return None
        metadata = validated(json.loads(result.stdout), value.url)
        return metadata if clock() <= deadline else None
    except (subprocess.TimeoutExpired, OSError, ValueError, UnicodeError):
        return None
