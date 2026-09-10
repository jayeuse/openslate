"""Bounded SDK process for a fixed, operator-managed ClamAV generation."""

import json
import os
import subprocess
import sys
from hashlib import sha256
from pathlib import Path
from time import monotonic
from typing import Literal, cast
from uuid import UUID

from app.systems.files.providers import (
    ProviderUnavailable,
    ScannerExecutionUncertain,
    ScannerPolicyRejected,
    ScanVerdict,
)

MAX_BYTES = 25 * 1024 * 1024
MAX_REPLY = 2048


class ClamAVScanner:
    def __init__(self, host: str, port: int, manifest_path: str | Path) -> None:
        self.host = host
        self.port = port
        self.manifest_path = Path(manifest_path)
        self._manifest_json: str | None = None

    def _run(self, content: bytes, mode: str) -> dict[str, str]:
        deadline = monotonic() + 60
        if self._manifest_json is None:
            try:
                with self.manifest_path.open("rb") as source:
                    raw = source.read(8193)
                if len(raw) > 8192:
                    raise ValueError
                self._manifest_json = raw.decode("utf-8")
            except (OSError, ValueError):
                raise ProviderUnavailable("Scanner manifest is unavailable") from None
        # The child is trusted code. Its only stdout write is a bounded JSON object;
        # provider text and stderr are never forwarded into application logs.
        try:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "app.systems.files.clamav_client",
                    mode,
                    self.host,
                    str(self.port),
                    self._manifest_json,
                ],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                cwd=Path(__file__).resolve().parents[3],
                env={"PATH": os.defpath, "PYTHONNOUSERSITE": "1", "TZ": "UTC", "LC_ALL": "C"},
            )
        except OSError:
            raise ProviderUnavailable("Scanner client could not start") from None
        try:
            output, _ = process.communicate(content, timeout=max(0, deadline - monotonic() - 2))
        except (subprocess.TimeoutExpired, OSError):
            try:
                process.kill()
                process.communicate(timeout=max(0, deadline - monotonic()))
            except (subprocess.TimeoutExpired, OSError):
                # Never wait indefinitely for reap. An unresolved client also
                # leaves engine execution unresolved and must fence new scans.
                raise ScannerExecutionUncertain("Scanner cleanup is unresolved") from None
            if mode == "probe":
                raise ProviderUnavailable("Scanner readiness timed out") from None
            raise ScannerExecutionUncertain("Scanner execution is unresolved") from None
        uncertain = ScannerExecutionUncertain if mode == "scan" else ProviderUnavailable
        if process.returncode != 0 or len(output) > MAX_REPLY:
            raise uncertain("Scanner client response is unresolved")
        try:
            value = json.loads(output)
            if not isinstance(value, dict) or not all(
                isinstance(k, str) and isinstance(v, str) and len(v) <= 200
                for k, v in value.items()
            ):
                raise ValueError
        except (ValueError, UnicodeError):
            raise uncertain("Scanner client response is unresolved") from None
        if value == {"error": "unavailable"}:
            raise ProviderUnavailable("Scanner is unavailable")
        if value == {"error": "policy"}:
            raise ScannerPolicyRejected("Scanner inspection policy rejected the file")
        if value == {"error": "uncertain"}:
            raise uncertain("Scanner execution is unresolved")
        if set(value) != {"outcome", "digest", "scanner_version", "signature_version"}:
            raise uncertain("Scanner client response is unresolved")
        if (
            value["outcome"] not in {"clean", "infected", "unknown"}
            or not value["scanner_version"]
            or not value["signature_version"]
            or value["digest"] != sha256(content).hexdigest()
        ):
            raise uncertain("Scanner client response is unresolved")
        return value

    def probe(self) -> None:
        self._run(b"", "probe")

    def scan(self, content: bytes, *, digest: str, operation_id: UUID) -> ScanVerdict:
        if not content or len(content) > MAX_BYTES or sha256(content).hexdigest() != digest:
            raise ProviderUnavailable("Scan input identity is invalid")
        value = self._run(content, "scan")
        outcome = value["outcome"]
        return ScanVerdict(
            cast(Literal["clean", "infected", "unknown"], outcome),
            digest,
            value["scanner_version"],
            value["signature_version"],
        )
