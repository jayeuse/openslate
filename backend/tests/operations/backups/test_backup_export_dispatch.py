"""Real private dispatcher projections with only adopted API helpers replaced."""

import copy
import json
import os
import subprocess
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest

from app.systems.manage.backups import exports
from app.systems.manage.backups.schemas import (
    ExportClaimFirst,
    ExportClaimReplay,
    ExportClaimResponse,
    ExportInspectResponse,
    ExportMutationResponse,
)
from operations import backup_state
from operations.backups import export_files
from operations.backups.host import Host, RunnerError, private_json
from tests.operations.backups.backup_runner_fixtures import NOW, execute, runner_config
from tests.operations.backups.export_runner_fixtures import (
    ExportCommands,
    ResticCommands,
    command_document,
    expired_artifact,
    inline_export_child,
    published_cleanup_fixture,
)


def test_private_export_inspection_dispatches_typed_safe_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    raw = {"op": "inspect-export", "installation_id": "client-a", "project": "client-a"}
    command = backup_state.COMMAND_ADAPTER.validate_python(raw)
    reply = ExportInspectResponse(unresolved=None, claim=None, cleanup_candidates=[])
    monkeypatch.setattr(exports, "inspect_exports", lambda *args: reply)
    actual = backup_state.execute(object(), command)
    assert actual == {"unresolved": None, "claim": None, "cleanup_candidates": []}


@pytest.mark.parametrize("status", ["first", "replay"])
def test_private_export_claim_dispatch_preserves_first_only_secret(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    status: str,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)
    command = backup_state.COMMAND_ADAPTER.validate_python(command_document("claim-export"))
    claim = ExportClaimResponse.model_validate(
        commands.claim_export(str(command.claim_id))["claim"]
    )
    reply = (
        ExportClaimFirst(status="first", claim=claim, passphrase=commands.passphrase)
        if status == "first"
        else ExportClaimReplay(status="replay", claim=claim)
    )
    session = object()

    def claimed(db: object, instance: str, claim_id: object) -> Any:
        assert db is session and instance == "client-a" and claim_id == command.claim_id
        return reply

    monkeypatch.setattr(exports, "claim_export", claimed)
    actual = backup_state.execute(session, command)
    assert actual == reply.model_dump(mode="json")
    assert ("passphrase" in actual) is (status == "first")
    if status == "first":
        assert actual["passphrase"] == commands.passphrase
        assert commands.passphrase not in repr(reply)


@pytest.mark.parametrize("op", ["export-outcome", "export-cleaned"])
def test_private_export_mutation_dispatch_returns_only_typed_claim(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    op: str,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)
    raw = command_document(op)
    if op == "export-cleaned":
        expired_artifact(tmp_path / "backup-exports", commands)
        document = commands.cleanup[0]
        document["artifact_deleted_at"] = NOW.isoformat()
        raw.update(export_id=document["export"]["id"], claim_id=document["claim_id"])
    else:
        commands.claim_export(raw["claim_id"])
        raw["export_id"] = commands.export_id
        document = commands.export_reply(raw)["claim"]
    command = backup_state.COMMAND_ADAPTER.validate_python(raw)
    reply = ExportMutationResponse(claim=ExportClaimResponse.model_validate(document))
    session, row = object(), object()

    def recorded(db: object, instance: str, received: object) -> object:
        assert db is session and instance == "client-a" and received is command
        return row

    def projected(db: object, received: object, instance: str) -> ExportClaimResponse:
        assert db is session and received is row and instance == "client-a"
        return reply.claim

    helper = (
        exports.record_export_outcome if op == "export-outcome" else exports.record_export_cleaned
    )
    monkeypatch.setattr(exports, helper.__name__, recorded)
    monkeypatch.setattr(exports, "export_claim_response", projected)
    actual = backup_state.execute(session, command)
    assert actual == reply.model_dump(mode="json")
    assert "passphrase" not in actual and "passphrase" not in actual["claim"]


@pytest.mark.parametrize(
    "log_fault", [None, "volume", "readonly", "wrong_source", "private_overlap"]
)
def test_private_claim_reply_over_16k_refuses_valid_json_without_journaling_secret(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    log_fault: str | None,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ExportCommands(config, state)

    def padded(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        result = commands(args, **kwargs)
        if (
            args[-1] == "operations/backup_state.py"
            and json.loads(kwargs["input"])["op"] == "claim-export"
        ):
            ExportClaimFirst.model_validate(json.loads(result.stdout))
            return subprocess.CompletedProcess(
                args, result.returncode, b" " * 16384 + result.stdout, b""
            )
        return result

    monkeypatch.setattr(export_files, "EXPORT_GID", os.getegid())
    host = Host(config, state, padded)
    if log_fault is not None:
        api = next(
            item
            for item in commands.containers
            if item["Config"]["Labels"]["com.docker.compose.service"] == "api"
        )
        logs = next(item for item in api["Mounts"] if item["Destination"] == "/var/log/openslate")
        if log_fault == "volume":
            logs.update(Type="volume", Name="client-a_openslate-logs")
        elif log_fault == "readonly":
            logs["RW"] = False
        else:
            logs["Source"] = str(tmp_path / "repository")
            if log_fault == "private_overlap":
                provider = tmp_path / "provider.env"
                provider.write_text(
                    provider.read_text().replace(str(tmp_path / "logs"), logs["Source"])
                )
        with pytest.raises(RunnerError, match="admission_failed"):
            host.admit()
        assert not commands.operations and not commands.export_operations
        assert commands.secret_handoffs == 0
        return
    host.admit()
    with host.locked():
        journal = host.prepare(command_document("claim-export")["claim_id"], [])
        journal["kind"] = "export"
        host.save(journal)
        with pytest.raises(RunnerError, match="result_unconfirmed"):
            host.bridge({"op": "claim-export", "claim_id": journal["claim_id"]}, journal)
    assert commands.secret_handoffs == 1
    assert commands.passphrase.encode() not in b"".join(
        path.read_bytes() for path in state.rglob("*.json")
    )


def test_ready_requires_durable_publication_proof_before_private_bridge(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config, state = runner_config(tmp_path)
    commands = ResticCommands(config, state)
    inline_export_child(monkeypatch, commands)
    original = Host.save

    def without_proof(host: Host, journal: dict[str, Any]) -> None:
        saved = copy.deepcopy(journal)
        if saved["phase"] == "published":
            saved.pop("publication", None)
        original(host, saved)

    monkeypatch.setattr(Host, "save", without_proof)
    with pytest.raises(RunnerError, match="result_unconfirmed"):
        execute(config, state, commands)
    assert not any(
        item["op"] == "export-outcome" and item["state"] == "ready"
        for item in commands.export_operations
    )
    assert commands.export_claim is not None
    assert commands.export_claim["export"]["state"] == "preparing"
    assert (tmp_path / "backup-exports" / (commands.export_id + ".tar")).is_file()


@pytest.mark.parametrize(
    "fault", ["changed", "replaced", "missing_proof", "foreign_proof", "hardlink"]
)
def test_expired_cleanup_refuses_changed_or_unproven_publication_identity(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    fault: str,
) -> None:
    config, state, commands, path = published_cleanup_fixture(tmp_path, monkeypatch)
    before = path.stat()
    if fault == "changed":
        with path.open("r+b") as stream:
            stream.write(b"X")
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    elif fault == "replaced":
        replacement = path.with_suffix(".replacement")
        replacement.write_bytes(path.read_bytes())
        replacement.chmod(0o640)
        os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
        os.replace(replacement, path)
    elif fault == "hardlink":
        os.link(path, path.with_suffix(".retain"))
    else:
        claim_id = commands.cleanup[0]["claim_id"]
        journal_path = state / "client-a/claims" / claim_id / "journal.json"
        journal = json.loads(journal_path.read_text())
        if fault == "missing_proof":
            journal.pop("publication", None)
        else:
            journal["installation_id"] = "other-client"
        private_json(journal_path, journal)
    retained = path.read_bytes()
    with pytest.raises(RunnerError, match="result_unconfirmed"):
        execute(config, state, commands, now=lambda: NOW + timedelta(hours=25))
    assert path.read_bytes() == retained
    assert not any(item["op"] == "export-cleaned" for item in commands.export_operations)
