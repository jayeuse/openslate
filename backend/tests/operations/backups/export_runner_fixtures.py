"""Closed export API/Restic responses and explicit process fakes for owned journeys."""

import copy
import hashlib
import json
import os
import stat
import subprocess
import time
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

import pytest

from app.systems.manage.backups.schemas import ExportOutcomeCommand
from operations.backups.host import Host, RunnerError, physical_archive
from tests.operations.backups.backup_runner_fixtures import (
    NOW,
    SNAPSHOT,
    SyntheticCommands,
    execute,
    runner_config,
)
from tests.operations.backups.test_backup_runner_retention import candidate

EXPORT_OPS = {"claim-export", "inspect-export", "export-outcome", "export-cleaned"}


class ExportCommands(SyntheticCommands):
    """Model only the adopted bridge handoff/replay states at the host boundary."""

    def __init__(self, config: Path, state: Path) -> None:
        super().__init__(config)
        self.config_path, self.state_directory = config, state
        self.queue = False
        self.pending = 1
        self.export_id = str(uuid4())
        self.export_claim: dict[str, Any] | None = None
        self.source = candidate(config, state, self, SNAPSHOT, 2)
        self.source_failure: str | None = None
        self.cleanup: list[dict[str, Any]] = []
        self.secret_handoffs = 0
        self.passphrase = "Synthetic export passphrase 中文 123456"

    def claim_export(self, claim_id: str) -> dict[str, Any]:
        if self.export_claim is not None:
            return {"status": "replay", "claim": self.export_claim}
        if not self.pending:
            return {"status": "none", "claim": None}
        self.pending -= 1
        self.export_claim = {
            "export": {
                "id": self.export_id,
                "backup_run_id": self.source["run"]["id"],
                "state": "failed" if self.source_failure else "preparing",
                "requested_at": NOW.isoformat(),
                "ready_at": None,
                "expires_at": None,
                "size_bytes": None,
                "sha256": None,
                "failure_code": self.source_failure,
            },
            "claim_id": claim_id,
            "installation_id": "client-a",
            "claimed_at": NOW.isoformat(),
            "finished_at": NOW.isoformat() if self.source_failure else None,
            "artifact_deleted_at": None,
            "source": self.source,
        }
        if self.source_failure:
            return {"status": "replay", "claim": self.export_claim}
        self.secret_handoffs += 1
        return {"status": "first", "claim": self.export_claim, "passphrase": self.passphrase}

    def export_reply(self, request: dict[str, Any]) -> dict[str, Any]:
        op = request["op"]
        if op == "claim-export":
            return self.claim_export(request["claim_id"])
        if op == "inspect-export":
            claim = self.export_claim
            exact = claim if claim and request.get("claim_id") == claim["claim_id"] else None
            unresolved = claim if claim and claim["export"]["state"] == "preparing" else None
            cleanup = [item for item in self.cleanup if item["artifact_deleted_at"] is None][:16]
            return {"unresolved": unresolved, "claim": exact, "cleanup_candidates": cleanup}
        if op == "export-outcome":
            claim = self.export_claim
            assert claim is not None, "Outcome requires the fixture's exact export claim"
            assert request["claim_id"] == claim["claim_id"]
            assert request["export_id"] == claim["export"]["id"]
            claim["finished_at"] = request["finished_at"]
            for field in ("state", "size_bytes", "sha256", "failure_code"):
                claim["export"][field] = request[field]
            if request["state"] == "ready":
                claim["export"]["ready_at"] = NOW.isoformat()
                claim["export"]["expires_at"] = (NOW + timedelta(hours=24)).isoformat()
            return {"claim": claim}
        claim = next(item for item in self.cleanup if item["export"]["id"] == request["export_id"])
        assert request["claim_id"] == claim["claim_id"]
        claim["artifact_deleted_at"] = request["deleted_at"]
        return {"claim": claim}

    def __call__(self, args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        if args[:2] == ["docker", "run"] and args[-1] == "operations/backup_state.py":
            request = json.loads(kwargs["input"])
            if request["op"] in EXPORT_OPS:
                self.calls.append((args, kwargs))
                self.export_operations.append(request)
                reply = self.export_reply(request)
                if self.ack_loss == request["op"]:
                    self.ack_loss = None
                    return self.result(args, {"code": "backup_state_unavailable"}, 3)
                return self.result(args, reply)
        return super().__call__(args, **kwargs)


def command_document(op: str) -> dict[str, Any]:
    document: dict[str, Any] = {
        "op": op,
        "installation_id": "client-a",
        "project": "client-a",
        "claim_id": str(uuid4()),
    }
    if op in {"inspect-export", "export-outcome", "export-cleaned"}:
        document["export_id"] = str(uuid4())
    if op == "export-outcome":
        document.update(
            state="failed",
            finished_at=NOW.isoformat(),
            size_bytes=None,
            sha256=None,
            failure_code="source_unavailable",
        )
    if op == "export-cleaned":
        document["deleted_at"] = NOW.isoformat()
    return document


class ResticCommands(ExportCommands):
    """Synthetic CLI responses exercise host ordering/filesystem work, not encryption."""

    def __init__(
        self, config: Path, state: Path, *, failure: str = "", payload_size: int = 0
    ) -> None:
        super().__init__(config, state)
        self.failure, self.copies = failure, 0
        self.payload_size = payload_size
        self.manifest = json.dumps(
            {
                "format_version": 3,
                "source_installation_id": "client-a",
                "source_project": self.config["project_name"],
                "deployment": "production",
                "created_at": self.source["run"]["verified_at"],
                "images": {},
                "volumes": [],
                "files": {},
            }
        ).encode()
        self.source["run"]["manifest_sha256"] = hashlib.sha256(self.manifest).hexdigest()
        marker = state / "client-a/claims" / self.source["claim_id"] / "backup-complete.json"
        facts = json.loads(marker.read_text())
        facts["manifest_sha256"] = self.source["run"]["manifest_sha256"]
        marker.write_text(json.dumps(facts))

    def __call__(self, args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        if args[0] != "restic":
            return super().__call__(args, **kwargs)
        self.calls.append((args, kwargs))
        verb = next(
            value
            for value in args
            if value
            in {
                "init",
                "copy",
                "check",
                "snapshots",
                "dump",
                "cat",
                "ls",
            }
        )
        if verb == self.failure:
            return self.result(args, b"", 1)
        repository = Path(kwargs["env"]["RESTIC_REPOSITORY"])
        source = repository == Path(self.config["restic_repository"])
        if verb == "init":
            repository.mkdir(mode=0o700, parents=True, exist_ok=True)
            (repository / "config").write_bytes(b"synthetic encrypted configuration")
            (repository / "data").mkdir()
            (repository / "data/ciphertext").write_bytes(b"synthetic encrypted content")
            if self.payload_size:
                with (repository / "data/ciphertext").open("r+b") as payload:
                    payload.truncate(self.payload_size)
        if verb == "copy":
            assert args.count(SNAPSHOT) == 1, "Copy must select the exact admitted source snapshot"
            self.copies += 1
        if verb == "check":
            assert "--read-data" in args
        if verb == "snapshots":
            identifiers = [SNAPSHOT] if source else ["d" * 64]
            if not source and self.failure == "multiple_snapshots":
                identifiers.append("e" * 64)
            return self.result(
                args, [{"id": key, "paths": ["/installation"]} for key in identifiers]
            )
        if verb == "dump":
            return self.result(
                args, b"corrupt manifest" if self.failure == "manifest" else self.manifest
            )
        if verb == "ls":
            return self.result(args, b'{"type":"file","path":"/installation/manifest.json"}\n')
        return self.result(args, b"{}" if verb == "cat" else b"")


def expired_artifact(root: Path, commands: ExportCommands) -> Path:
    """Seed synthetic private publication facts; this is not encryption proof."""
    commands.pending = 1
    claim = commands.claim_export(str(uuid4()))["claim"]
    commands.export_claim, commands.pending = None, 0
    claim["export"].update(
        id=str(uuid4()),
        state="expired",
        ready_at=(NOW - timedelta(hours=25)).isoformat(),
        expires_at=(NOW - timedelta(hours=1)).isoformat(),
        size_bytes=7,
        sha256=hashlib.sha256(b"archive").hexdigest(),
        failure_code=None,
    )
    claim["finished_at"] = claim["export"]["ready_at"]
    claim["claimed_at"] = (NOW - timedelta(hours=26)).isoformat()
    claim["export"]["requested_at"] = claim["claimed_at"]
    commands.cleanup.append(claim)
    path = root / (claim["export"]["id"] + ".tar")
    path.write_bytes(b"archive")
    path.chmod(0o640)
    host = Host(commands.config_path, commands.state_directory, commands)
    host.config = physical_archive().parse_config(commands.config_path)
    host.containers = commands.containers
    with host.locked():
        journal = host.prepare(claim["claim_id"], [])
        details = path.stat()
        journal.update(
            kind="export",
            claim=claim,
            publication={
                "st_dev": details.st_dev,
                "st_ino": details.st_ino,
                "st_size": details.st_size,
                "st_mtime_ns": details.st_mtime_ns,
                "st_ctime_ns": details.st_ctime_ns,
                "st_uid": details.st_uid,
                "st_gid": details.st_gid,
                "st_mode": stat.S_IMODE(details.st_mode),
                "st_nlink": details.st_nlink,
            },
        )
        journal["outcome"] = ExportOutcomeCommand(
            op="export-outcome",
            installation_id="client-a",
            project=host.config.project_name,
            export_id=claim["export"]["id"],
            claim_id=claim["claim_id"],
            state="ready",
            finished_at=claim["finished_at"],
            size_bytes=7,
            sha256=claim["export"]["sha256"],
            failure_code=None,
        ).model_dump(mode="json")
        host.finish(journal)
    return path


def inline_export_child(monkeypatch: pytest.MonkeyPatch, commands: SyntheticCommands) -> None:
    """An explicit process fake; this is not real child or encrypted interoperability proof."""

    def launch(args: list[str], **kwargs: Any) -> SimpleNamespace:
        from operations.backups.exports import export_child

        host = Host(
            Path(args[args.index("--backup-config") + 1]),
            Path(args[args.index("--state-directory") + 1]),
            commands,
        )
        code = 0
        with monkeypatch.context() as child_context:
            child_context.setattr(os, "getpid", lambda: 771)
            child_context.setattr(os, "getpgid", lambda pid: 771)
            try:
                export_child(
                    host, args[args.index("--claim-id") + 1], int(args[args.index("--lock-fd") + 1])
                )
            except RunnerError:
                code = 3
        return SimpleNamespace(pid=771, wait=lambda **values: code)

    def ended(pgid: int, signal: int) -> None:
        raise ProcessLookupError

    monkeypatch.setattr(subprocess, "Popen", launch)
    monkeypatch.setattr(os, "killpg", ended)


def published_cleanup_fixture(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    large: bool = False,
) -> tuple[Path, Path, ResticCommands, Path]:
    config, state = runner_config(tmp_path)
    commands = ResticCommands(config, state, payload_size=4 * 1048576 if large else 0)
    inline_export_child(monkeypatch, commands)
    assert execute(config, state, commands)["state"] == "ready"
    assert commands.export_claim is not None
    commands.cleanup.append(copy.deepcopy(commands.export_claim))
    commands.export_claim, commands.pending = None, 0
    commands.last_release_checked_at = (NOW + timedelta(hours=25)).isoformat()
    return config, state, commands, tmp_path / "backup-exports" / (commands.export_id + ".tar")


def simulate_slow_cleanup_hash(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """No sleep: each archive-size hashing chunk consumes more than the full tick budget."""
    elapsed = [0.0]
    original = hashlib.sha256

    class SlowHash:
        def __init__(self, data: bytes = b"") -> None:
            self.inner = original(data)

        def update(self, data: bytes) -> None:
            if len(data) >= 1048576:
                elapsed[0] += 16
            self.inner.update(data)

        def hexdigest(self) -> str:
            return self.inner.hexdigest()

        def digest(self) -> bytes:
            return self.inner.digest()

    monkeypatch.setattr(hashlib, "sha256", SlowHash)
    monkeypatch.setattr(time, "monotonic", lambda: elapsed[0])
    return elapsed
