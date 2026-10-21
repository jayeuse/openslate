"""Guarded native test entry only: replace external I/O, not API/auth/worker/persistence."""

import json
import os
from pathlib import Path

from app.systems.comms.previews import jobs, process
from tests.realtime.measured_api import app as app

if os.environ.get("OPENSLATE_COMMS_NATIVE_API") != "http://127.0.0.1:8008":
    raise RuntimeError("Owned native preview fixture requires the guarded runner")

process.CHILD_MODULE = "tests.comms.previews.controlled_child"
_fetch = jobs.fetch_bounded
_journal = Path(os.environ["OPENSLATE_COMMS_TELEMETRY"]).with_name("preview-fetches.jsonl")


def observed_fetch(url):
    with _journal.open("a") as output:
        output.write(json.dumps({"event": "preview_fetch_started"}) + "\n")
    return _fetch(url)


jobs.fetch_bounded = observed_fetch
