"""Daily append-only local diagnostics and compact terminal presentation."""

import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import TextIO


class DailyLogHandler(logging.Handler):
    """One append syscall per record; no retained files or background workers.

    O_APPEND supports local multi-process writers without rename/rotation races.
    Use local storage: network filesystems need their own append guarantees.
    """

    _openslate_observability = True

    def __init__(self, directory: Path, stream: TextIO | None = None) -> None:
        super().__init__()
        self.directory = directory
        self.stream = stream if stream is not None else sys.stdout
        self._last_failure = float("-inf")

    def emit(self, record: logging.LogRecord) -> None:
        payload = json.loads(record.getMessage())
        persisted = False
        try:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            path = self.directory / f"{payload['timestamp'][:10]}.log"
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                content = (record.getMessage() + "\n").encode("utf-8")
                if os.write(descriptor, content) != len(content):
                    raise OSError("incomplete append")
            finally:
                os.close(descriptor)
            persisted = True
            if self._last_failure != float("-inf"):
                self._last_failure = float("-inf")
                self._terminal("INFO API log_sink_recovered reason=file_write_restored\n")
        except OSError:
            now = time.monotonic()
            if now - self._last_failure >= 60:
                self._last_failure = now
                self._terminal("ERROR API log_sink_failure reason=file_write_failed\n")
        if not persisted or not (
            payload.get("event") == "http_request"
            and payload.get("route") in {"/api/health", "/api/ready"}
            and payload.get("status") == 200
        ):
            self._terminal(_summary(payload))

    def _terminal(self, text: str) -> None:
        try:
            self.stream.write(text)
            self.stream.flush()
        except (OSError, ValueError):
            # Logging must never change the request outcome, including a closed pipe.
            pass


def _summary(payload: dict[str, object]) -> str:
    timestamp = str(payload["timestamp"])[11:19]
    severity = str(payload["severity"]).replace("WARNING", "WARN")
    if payload["event"] == "http_request":
        detail = " ".join(str(payload.get(key, "-")) for key in ("method", "route", "status"))
        detail += f" {payload.get('duration_ms', 0)}ms"
    else:
        detail = str(payload["event"])
        if "route" in payload:
            detail += f" {payload.get('method', '-')} {payload['route']}"
    keys = ["reason_code", "upstream"]
    if severity not in {"INFO", "DEBUG"}:
        keys.extend(["request_id", "operation_id"])
    for key in keys:
        if key in payload:
            label = "reason" if key == "reason_code" else key
            detail += f" {label}={payload[key]}"
    return f"{timestamp}Z {severity} API {detail}\n"
