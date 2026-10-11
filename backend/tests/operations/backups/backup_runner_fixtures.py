"""Shared synthetic Docker/Restic/bridge boundary fixtures for host operator tests."""

import hashlib
import json
import os
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from operations.backup_runner import ArchiveRunner, Clock, run_once
from tests.repository import REPOSITORY_ROOT

NOW = datetime(2026, 10, 3, 12, tzinfo=UTC)


SNAPSHOT = "f" * 64


MANIFEST = "a" * 64


SERVICES = (
    "db",
    "auth",
    "rest",
    "storage",
    "imgproxy",
    "meta",
    "studio",
    "api-gw",
    "provider-volume-init",
    "api",
    "caddy",
)


VOLUMES = (
    "supabase-db-data",
    "supabase-db-config",
    "supabase-storage-data",
    "supabase-studio-snippets",
    "caddy-data",
)


def private_file(path: Path, value: str) -> Path:
    path.write_text(value)
    path.chmod(0o600)
    return path


def runner_config(tmp_path: Path, *, deployment: str = "production") -> tuple[Path, Path]:
    for name in ("repository", "staging", "markers", "state", "tls", "logs"):
        (tmp_path / name).mkdir(mode=0o700)
    (tmp_path / "backup-exports").mkdir(mode=0o750)
    (tmp_path / "backup-exports").chmod(0o750)
    private_file(tmp_path / "tls" / "certificate", "synthetic certificate")
    provider = private_file(
        tmp_path / "provider.env",
        "OPENSLATE_INSTANCE_ID=client-a\n"
        f"OPENSLATE_BACKUP_EXPORT_ROOT={tmp_path / 'backup-exports'}\n"
        f"OPENSLATE_LOG_ROOT={tmp_path / 'logs'}\n",
    )
    app = private_file(
        tmp_path / "app.env",
        "ENVIRONMENT=production\nOPENSLATE_INSTANCE_ID=client-a\n"
        "POSTGRES_HOST=db\nPOSTGRES_PORT=5432\nPOSTGRES_DATABASE=postgres\n"
        "DATABASE_URL=postgresql://openslate_runtime:synthetic@db:5432/postgres\n"
        "PUBLIC_ORIGIN=https://example.invalid\n"
        "BACKUP_EXPORT_ROOT=/var/lib/openslate/backup-exports\n",
    )
    caddy = private_file(tmp_path / "Caddyfile", "synthetic caddy configuration")
    password = private_file(tmp_path / "password", "synthetic test password")
    config = {
        "version": 3,
        "installation_id": "client-a",
        "project_name": "client-a",
        "deployment": deployment,
        "compose_root": str(REPOSITORY_ROOT / "infra" / "supabase"),
        "provider_env_file": str(provider),
        "app_env_file": str(app) if deployment == "production" else None,
        "caddy_config_file": str(caddy) if deployment == "production" else None,
        "tls_directory": str(tmp_path / "tls") if deployment == "production" else None,
        "restic_repository": str(tmp_path / "repository"),
        "restic_password_file": str(password),
        "staging_directory": str(tmp_path / "staging"),
        "completion_marker": str(tmp_path / "markers" / "unused-template-marker.json"),
    }
    return private_file(tmp_path / "backup.json", json.dumps(config)), tmp_path / "state"


class NoCommands:
    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def __call__(self, args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        self.calls.append(args)
        raise AssertionError("External commands must not run before production admission")


def claim_document(
    *, claim_id: str | None = None, snapshot: str | None = None, completed: str | None = None
) -> dict[str, Any]:
    return {
        "claim_id": claim_id or str(uuid4()),
        "installation_id": "client-a",
        "scheduled_for": None,
        "claimed_schedule": "disabled",
        "claimed_retention_days": 30,
        "run": {
            "id": str(uuid4()),
            "name": "Owned backup",
            "provenance": "manual",
            "installation": "current",
            "state": "succeeded" if snapshot else "running",
            "requested_at": NOW.isoformat(),
            "started_at": NOW.isoformat(),
            "finished_at": completed,
            "reconciled_at": completed,
            "schedule": "disabled",
            "retention_days": 30,
            "snapshot_id": snapshot,
            "manifest_sha256": MANIFEST if snapshot else None,
            "verified_at": completed if snapshot else None,
            "failure_code": None,
            "expired_at": None,
        },
    }


class SyntheticCommands:
    """Responses follow actual Docker/Restic argv and the frozen JSON bridge."""

    def __init__(self, config: Path) -> None:
        self.config = json.loads(config.read_text())
        self.calls: list[tuple[list[str], dict[str, Any]]] = []
        self.operations: list[dict[str, Any]] = []
        self.export_operations: list[dict[str, Any]] = []
        self.claim: dict[str, Any] | None = None
        self.candidates: list[dict[str, Any]] = []
        self.snapshots = {SNAPSHOT}
        self.queue = True
        self.adopted = True
        self.ack_loss: str | None = None
        self.readiness = True
        self.orphan = False
        self.fail_forget = False
        self.prunes = 0
        self.recreate_on_up = False
        self.last_release_checked_at: str | None = NOW.isoformat()
        self.policy = {
            "schedule": "disabled",
            "retention_days": 30,
            "revision": 1,
            "timezone": "UTC",
            "next_due_at": None,
            "adopted": True,
        }
        self.containers = [self.container(name) for name in SERVICES]
        self.original_running = {
            name for name in SERVICES if name not in {"provider-volume-init", "studio"}
        }

    def container(self, name: str) -> dict[str, Any]:
        identity = hashlib.sha256(name.encode()).hexdigest()
        mounts = {
            "db": (
                ("supabase-db-data", "/var/lib/postgresql/data", True),
                ("supabase-db-config", "/etc/postgresql-custom", True),
            ),
            "storage": (("supabase-storage-data", "/var/lib/storage", True),),
            "imgproxy": (("supabase-storage-data", "/var/lib/storage", False),),
            "studio": (("supabase-studio-snippets", "/app/snippets", True),),
            "provider-volume-init": (
                ("supabase-storage-data", "/var/lib/storage", True),
                ("supabase-studio-snippets", "/app/snippets", True),
            ),
            "caddy": (("caddy-data", "/data", True),),
        }
        return {
            "Id": identity,
            "Image": "sha256:" + identity,
            "Config": {
                "Image": f"synthetic/{name}@sha256:{identity}",
                "Labels": {
                    "com.docker.compose.project": self.config["project_name"],
                    "com.docker.compose.service": name,
                    "com.docker.compose.project.working_dir": self.config["compose_root"],
                },
                "Env": [
                    "ENVIRONMENT=production",
                    "OPENSLATE_INSTANCE_ID=client-a",
                    "POSTGRES_HOST=db",
                    "POSTGRES_PORT=5432",
                    "POSTGRES_DATABASE=postgres",
                    "DATABASE_URL=postgresql://openslate_runtime:synthetic@db:5432/postgres",
                    "PUBLIC_ORIGIN=https://example.invalid",
                    "BACKUP_EXPORT_ROOT=/var/lib/openslate/backup-exports",
                ],
            },
            "State": {
                "Status": "exited" if name in {"provider-volume-init", "studio"} else "running",
                "Running": name not in {"provider-volume-init", "studio"},
            },
            "Mounts": [
                {
                    "Type": "volume",
                    "Name": self.config["project_name"] + "_" + logical,
                    "Destination": destination,
                    "RW": writable,
                }
                for logical, destination, writable in mounts.get(name, ())
            ]
            + (
                [
                    {
                        "Type": "bind",
                        "Source": str(Path(self.config["restic_repository"]).parent / "logs"),
                        "Destination": "/var/log/openslate",
                        "RW": True,
                    },
                    {
                        "Type": "bind",
                        "Source": str(
                            Path(self.config["restic_repository"]).parent / "backup-exports"
                        ),
                        "Destination": "/var/lib/openslate/backup-exports",
                        "RW": False,
                    },
                ]
                if name == "api"
                else []
            ),
            "NetworkSettings": {
                "Networks": {self.config["project_name"] + "_provider": {"NetworkID": "b" * 64}}
            },
        }

    def result(
        self, args: list[str], value: Any = None, code: int = 0
    ) -> subprocess.CompletedProcess[bytes]:
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        return subprocess.CompletedProcess(
            args, code, data, b"synthetic private vendor error" if code else b""
        )

    def __call__(self, args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        self.calls.append((args, kwargs))
        if args[:2] == ["docker", "ps"]:
            entries = self.containers + ([self.orphan_container()] if self.orphan else [])
            return self.result(args, "\n".join(item["Id"] for item in entries).encode())
        if args[:3] == ["docker", "container", "inspect"]:
            entries = self.containers + ([self.orphan_container()] if self.orphan else [])
            return self.result(args, [item for item in entries if item["Id"] in args[3:]])
        if args[:3] == ["docker", "volume", "ls"]:
            return self.result(
                args,
                "\n".join(self.config["project_name"] + "_" + name for name in VOLUMES).encode(),
            )
        if args[:3] == ["docker", "volume", "inspect"]:
            project = self.config["project_name"]
            return self.result(
                args,
                [
                    {
                        "Name": name,
                        "Labels": {
                            "com.docker.compose.project": project,
                            "com.docker.compose.volume": name[len(project) + 1 :],
                        },
                        "Mountpoint": "/var/lib/docker/volumes/" + name + "/_data",
                    }
                    for name in args[3:]
                ],
            )
        if args[:3] == ["docker", "network", "inspect"]:
            return self.result(
                args,
                [
                    {
                        "Id": "b" * 64,
                        "Name": self.config["project_name"] + "_provider",
                        "Labels": {
                            "com.docker.compose.project": self.config["project_name"],
                            "com.docker.compose.network": "provider",
                        },
                    }
                ],
            )
        if args[:2] == ["docker", "compose"]:
            if "config" in args:
                return self.result(
                    args,
                    {
                        "services": {
                            item["Config"]["Labels"]["com.docker.compose.service"]: {
                                "image": item["Config"]["Image"]
                            }
                            for item in self.containers
                        }
                    },
                )
            names = (
                args[args.index("--wait-timeout") + 2 :]
                if "--wait-timeout" in args
                else (args[args.index("stop") + 1 :] if "stop" in args else [])
            )
            for item in self.containers:
                if ("stop" in args and not names) or item["Config"]["Labels"][
                    "com.docker.compose.service"
                ] in names:
                    item["State"] = {
                        "Status": "exited" if "stop" in args else "running",
                        "Running": "stop" not in args,
                    }
                    if "up" in args and self.recreate_on_up:
                        item["Id"] = hashlib.sha256((item["Id"] + "recreated").encode()).hexdigest()
                        item["Config"]["Labels"].pop("openslate.test.run", None)
            return self.result(args, b"")
        if args[:2] == ["docker", "start"]:
            for item in self.containers:
                if item["Id"] in args[2:]:
                    item["State"] = {
                        "Status": "running",
                        "Running": True,
                        "Health": {"Status": "healthy"},
                    }
            return self.result(args, "\n".join(args[2:]).encode())
        if args[:2] == ["docker", "exec"]:
            found = any(item["Id"] == args[2] for item in self.containers)
            return self.result(args, b"", 0 if self.readiness and found else 1)
        if args[:2] == ["docker", "run"] and args[-1] == "operations/backup_state.py":
            request = json.loads(kwargs["input"])
            op = request["op"]
            is_export = op in {"claim-export", "inspect-export", "export-outcome", "export-cleaned"}
            if is_export:
                self.export_operations.append(request)
            else:
                self.operations.append(request)
            if not next(
                item
                for item in self.containers
                if item["Config"]["Labels"]["com.docker.compose.service"] == "db"
            )["State"]["Running"]:
                return self.result(args, {"code": "database_unavailable"}, 3)
            if is_export:
                if op == "inspect-export":
                    return self.result(
                        args,
                        {
                            "unresolved": None,
                            "claim": None,
                            "cleanup_candidates": [],
                        },
                    )
                if op == "claim-export":
                    return self.result(args, {"status": "none", "claim": None})
                return self.result(args, {"code": "export_identity_conflict"}, 2)
            if op == "inspect":
                self.policy["adopted"] = self.adopted
                result = {
                    "policy": self.policy,
                    "policy_installation_id": "client-a" if self.adopted else "source-a",
                    "runner_last_seen_at": NOW.isoformat(),
                    "last_release_checked_at": self.last_release_checked_at,
                    "unresolved": self.claim
                    if self.claim and not self.claim["run"]["reconciled_at"]
                    else None,
                    "queued_count": int(self.queue),
                    "retention_candidates": self.candidates,
                    "claim": self.claim
                    if request.get("claim_id") == (self.claim or {}).get("claim_id")
                    else None,
                }
            elif op == "claim":
                if self.queue and self.claim is None:
                    self.claim = claim_document(claim_id=request["claim_id"])
                result = {"claim": self.claim}
            elif op == "outcome":
                assert self.claim
                self.claim["run"].update(
                    {
                        key: request[key]
                        for key in (
                            "state",
                            "finished_at",
                            "reconciled_at",
                            "snapshot_id",
                            "manifest_sha256",
                            "verified_at",
                            "failure_code",
                        )
                    }
                )
                result = {"claim": self.claim}
            elif op == "expire":
                candidate = next(
                    item for item in self.candidates if item["run"]["id"] == request["run_id"]
                )
                # Like service.record_expiry: the newest committed verified point is protected.
                newer = [
                    item
                    for item in self.candidates
                    if item["run"]["verified_at"]
                    and item["run"]["reconciled_at"]
                    and not item["run"]["expired_at"]
                    and item["run"]["verified_at"] > candidate["run"]["verified_at"]
                ]
                if not newer:
                    return self.result(args, {"code": "backup_latest_protected"}, 2)
                candidate["run"]["expired_at"] = request["expired_at"]
                result = {"claim": candidate}
            elif op == "heartbeat":
                assert self.claim and request["claim_id"] == self.claim["claim_id"]
                result = {"recorded": True}
            elif op == "release":
                self.last_release_checked_at = request["checked_at"]
                result = {"recorded": True}
            elif op == "adopt":
                self.adopted = True
                result = {"policy": {**self.policy, "adopted": True}}
            else:
                raise AssertionError(op)
            if self.ack_loss == op:
                self.ack_loss = None
                return self.result(args, {"code": "database_unavailable"}, 3)
            return self.result(args, result)
        if args[:2] == ["restic", "snapshots"]:
            return self.result(args, [{"id": snapshot} for snapshot in self.snapshots])
        if args[:2] == ["restic", "prune"]:
            self.prunes += 1
            return self.result(args, b"")
        if args[:2] == ["restic", "forget"]:
            if self.fail_forget:
                return self.result(args, b"", 1)
            self.snapshots.discard(args[-1])
            return self.result(args, b"")
        raise AssertionError(f"Unexpected external command: {args[0:3]}")

    def orphan_container(self) -> dict[str, Any]:
        return {
            "Id": "orphan-reader",
            "Config": {"Labels": {}},
            "State": {"Status": "running"},
            "Mounts": [
                {"Type": "volume", "Name": self.config["project_name"] + "_supabase-db-data"}
            ],
        }


def successful_archive(host: Any, journal: dict[str, Any]) -> None:
    config = json.loads(host.run_config(journal).read_text())
    private_file(
        Path(config["completion_marker"]),
        json.dumps(
            {
                "format_version": 3,
                "source_installation_id": host.config.installation_id,
                "source_project": host.config.project_name,
                "snapshot_id": SNAPSHOT,
                "manifest_sha256": MANIFEST,
                "completed_at": NOW.isoformat(),
            }
        ),
    )


def execute(
    config: Path,
    state: Path,
    commands: SyntheticCommands,
    *,
    project_export_group: bool = True,
    archive_runner: ArchiveRunner = successful_archive,
    now: Clock = lambda: NOW,
    **options: Any,
) -> dict[str, object]:
    """Native-temp positives project only gid; they do not prove deployed ownership."""
    from operations.backups import export_files

    assert export_files.EXPORT_GID == 10001
    with pytest.MonkeyPatch.context() as projection:
        if project_export_group:
            projection.setattr(export_files, "EXPORT_GID", os.getegid())
        return run_once(
            config,
            state,
            command_runner=commands,
            archive_runner=archive_runner,
            now=now,
            **options,
        )
