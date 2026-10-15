"""Private host admission, durable journal and constrained Docker boundaries."""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import subprocess
import sys
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from app.core.config.instance import instance_target_for_process

ROOT = Path(__file__).resolve().parents[3]
SERVICES = frozenset(
    {
        "db",
        "auth",
        "storage",
        "imgproxy",
        "meta",
        "studio",
        "api-gw",
        "provider-volume-init",
        "api",
        "caddy",
    }
)
Json = dict[str, Any]
CommandRunner = Callable[..., subprocess.CompletedProcess[bytes]]


class RunnerError(RuntimeError):
    """Only the safe code/message may cross the operator process boundary."""

    def __init__(self, code: str, message: str | None = None) -> None:
        self.code = code
        super().__init__(message or code)


def physical_archive() -> Any:
    """Load the existing release archive without changing its package/configuration."""
    path = str(ROOT / "packaging")
    if path not in sys.path:
        sys.path.insert(0, path)
    return importlib.import_module("backup.backup_installation")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def private_json(path: Path, payload: Json) -> None:
    physical_archive()._assert_no_symlink(path, "runner journal")
    temporary = path.parent / (".write-" + uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(payload, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def read_private_json(path: Path) -> Json:
    physical_archive()._private(path, "runner recovery material", directory=False)
    if path.stat().st_size > 262144:
        raise RunnerError("journal_invalid")
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise RunnerError("journal_invalid")
    return value


@dataclass
class Host:
    config_path: Path
    state_directory: Path
    command_runner: CommandRunner = subprocess.run
    platform_name: str = os.name
    config: Any = field(init=False)
    containers: list[Json] = field(init=False, default_factory=list, repr=False)
    image: str = field(init=False, default="")
    lock_fd: int = field(init=False, default=-1)

    def command(
        self,
        args: list[str],
        *,
        failure: str,
        timeout: float = 60,
        input: bytes | None = None,
        env: dict[str, str] | None = None,
    ) -> bytes:
        try:
            inherited = {"pass_fds": (self.lock_fd,)} if self.lock_fd >= 0 else {}
            result = self.command_runner(
                args,
                input=input,
                env=env or {name: os.environ[name] for name in ("PATH",) if name in os.environ},
                capture_output=True,
                check=False,
                timeout=timeout,
                **inherited,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RunnerError(failure) from error
        if result.returncode or len(result.stdout) > 1048576:
            raise RunnerError(failure)
        return result.stdout

    def docker_json(self, args: list[str]) -> Any:
        try:
            return json.loads(self.command(["docker", *args], failure="admission_failed"))
        except (ValueError, UnicodeDecodeError) as error:
            raise RunnerError("admission_failed") from error

    def inventory(self) -> list[Json]:
        identifiers = (
            self.command(["docker", "ps", "-aq"], failure="admission_failed").decode().split()
        )
        if not identifiers:
            raise RunnerError("admission_failed")
        values = self.docker_json(["container", "inspect", *identifiers])
        if (
            not isinstance(values, list)
            or len(values) != len(identifiers)
            or any(not isinstance(value, dict) for value in values)
        ):
            raise RunnerError("admission_failed")
        return values

    def admit(self) -> None:
        try:
            self._admit()
        except RunnerError:
            raise
        except (OSError, ValueError, KeyError, TypeError, physical_archive().BackupError) as error:
            raise RunnerError("admission_failed") from error

    def _admit(self) -> None:
        if self.platform_name == "nt":
            raise RunnerError("unsupported_platform", "Use Linux/WSL2; native Windows is refused")
        physical = physical_archive()
        if not self.config_path.is_absolute() or not self.state_directory.is_absolute():
            raise RunnerError("admission_failed")
        self.config = physical.parse_config(self.config_path)
        if self.config.deployment != "production":
            raise RunnerError("development_refused", "The runner requires production Compose")
        physical._private(self.config_path, "backup config", directory=False)
        physical._private(self.state_directory, "runner state", directory=True)
        if self.config.compose_root.resolve() != (ROOT / "infra/supabase").resolve():
            raise RunnerError("admission_failed")
        for path in (
            self.config.provider_env_file,
            self.config.app_env_file,
            self.config.caddy_config_file,
            self.config.restic_password_file,
        ):
            physical._private(path, "backup input", directory=False)
        for path in (
            self.config.compose_root,
            self.config.tls_directory,
            self.config.restic_repository,
            self.config.staging_directory,
            self.config.completion_marker.parent,
        ):
            physical._private(path, "backup directory", directory=True)
            if self.state_directory.resolve().is_relative_to(path.resolve()) or (
                path.resolve().is_relative_to(self.state_directory.resolve())
            ):
                raise RunnerError(
                    "admission_failed", "Runner state must be separate from backup inputs"
                )
        values: dict[str, str] = {}
        for line in self.config.app_env_file.read_text().splitlines():
            if not line or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator or key in values or value.startswith(("'", '"')):
                raise RunnerError(
                    "admission_failed", "Use a literal Docker application environment file"
                )
            values[key] = value
        if (
            values.get("ENVIRONMENT") != "production"
            or values.get("OPENSLATE_INSTANCE_ID") != self.config.installation_id
        ):
            raise RunnerError("admission_failed")
        try:
            target = instance_target_for_process(
                values["DATABASE_URL"], "openslate_runtime", values
            )
            if (
                target is None
                or target.host != "db"
                or target.port != 5432
                or target.instance_id != self.config.installation_id
            ):
                raise ValueError
        except (KeyError, ValueError) as error:
            raise RunnerError("admission_failed") from error
        from operations.backups.docker import admit_docker
        from operations.backups.export_files import admit_export

        admit_docker(self, values)
        admit_export(self, values)

    @staticmethod
    def labels(item: Json) -> dict[str, str]:
        labels = item.get("Config", {}).get("Labels", {})
        if not isinstance(labels, dict):
            raise RunnerError("admission_failed")
        return labels

    def _physical_command(
        self, args: list[str], **kwargs: Any
    ) -> subprocess.CompletedProcess[bytes]:
        data = self.command(args, failure="admission_failed", env=kwargs.get("env"))
        return subprocess.CompletedProcess(args, 0, data, b"")

    @property
    def directory(self) -> Path:
        return Path(self.state_directory, self.config.installation_id)

    @contextmanager
    def locked(self) -> Iterator[None]:
        import fcntl

        self.directory.mkdir(mode=0o700, exist_ok=True)
        physical_archive()._private(self.directory, "installation runner state", directory=True)
        path = self.directory / "lock"
        self.lock_fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            physical_archive()._private(path, "installation host lock", directory=False)
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise RunnerError("runner_busy") from error
            yield
        finally:
            os.close(self.lock_fd)
            self.lock_fd = -1

    def run_directory(self, journal: Json) -> Path:
        return self.directory / "claims" / str(UUID(journal["claim_id"]))

    def run_config(self, journal: Json) -> Path:
        return self.run_directory(journal) / "backup.json"

    def save(self, journal: Json) -> None:
        private_json(self.run_directory(journal) / "journal.json", journal)

    def prepare(self, claim_id: str, candidates: list[Json]) -> Json:
        claims = self.directory / "claims"
        claims.mkdir(mode=0o700, exist_ok=True)
        physical_archive()._private(claims, "claim journals", directory=True)
        directory = claims / str(UUID(claim_id))
        directory.mkdir(mode=0o700)
        raw = read_private_json(self.config_path)
        raw["completion_marker"] = str(directory / "backup-complete.json")
        config_path = directory / "backup.json"
        private_json(config_path, raw)
        physical = physical_archive()
        physical._separate(physical.parse_config(config_path), config_path)
        journal = {
            "version": 1,
            "installation_id": self.config.installation_id,
            "project": self.config.project_name,
            "claim_id": claim_id,
            "template_sha256": digest(self.config_path),
            "config_sha256": digest(config_path),
            "phase": "prepared",
            "claim": None,
            "child": None,
            "outcome": None,
            "expiry": None,
            "candidates": candidates,
            "services": {
                item["Id"]: {
                    "service": self.labels(item)["com.docker.compose.service"],
                    "running": item["State"]["Status"] == "running",
                    "image": item["Image"],
                }
                for item in self.containers
            },
        }
        self.save(journal)
        private_json(self.directory / "active.json", {"claim_id": claim_id})
        return journal

    def active(self) -> Json | None:
        path = self.directory / "active.json"
        if not path.exists():
            return None
        pointer = read_private_json(path)
        journal = read_private_json(self.run_directory(pointer) / "journal.json")
        if (
            journal.get("version") != 1
            or journal.get("claim_id") != pointer.get("claim_id")
            or journal.get("installation_id") != self.config.installation_id
            or journal.get("project") != self.config.project_name
            or journal.get("template_sha256") != digest(self.config_path)
            or journal.get("config_sha256") != digest(self.run_config(journal))
        ):
            raise RunnerError("journal_invalid")
        return journal

    def finish(self, journal: Json) -> None:
        journal["phase"] = "done"
        self.save(journal)
        (self.directory / "active.json").unlink()
        fsync_directory(self.directory)

    def finish_empty(self, journal: Json) -> None:
        self.finish(journal)
        directory = self.run_directory(journal)
        if {path.name for path in directory.iterdir()} != {"backup.json", "journal.json"}:
            raise RunnerError("journal_invalid")
        for name in ("backup.json", "journal.json"):
            (directory / name).unlink()
        directory.rmdir()
        fsync_directory(directory.parent)

    def bridge(self, command: Json, journal: Json | None = None, *, timeout: float = 60) -> Json:
        payload = {
            "installation_id": self.config.installation_id,
            "project": self.config.project_name,
            **command,
        }
        name = "openslate-backup-" + uuid4().hex
        args = [
            "docker",
            "run",
            "--rm",
            "--pull=never",
            "--name",
            name,
            "--network",
            self.config.project_name + "_provider",
            "--env-file",
            str(self.config.app_env_file),
            "--user",
            "10001:10001",
            "--read-only",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--no-healthcheck",
            "--interactive",
            "--env",
            "OPENSLATE_ENV_SOURCE=process",
            "--entrypoint",
            "python",
            self.image,
            "operations/backup_state.py",
        ]
        if journal is not None:
            journal["bridge"] = {"name": name, "command": payload}
            self.save(journal)
        try:
            data = self.command(
                args,
                failure="result_unconfirmed",
                input=json.dumps(payload).encode(),
                timeout=timeout,
            )
            if command.get("op") == "claim-export" and len(data) > 16384:
                raise RunnerError("result_unconfirmed")
            result = json.loads(data)
        except (ValueError, UnicodeDecodeError) as error:
            raise RunnerError("result_unconfirmed") from error
        if not isinstance(result, dict) or "code" in result:
            raise RunnerError("result_unconfirmed")
        if journal is not None:
            journal["bridge"] = None
            self.save(journal)
        return result

    def compose(self, tail: list[str], *, failure: str) -> None:
        self.command(
            [
                "docker",
                "compose",
                "--project-name",
                self.config.project_name,
                "--env-file",
                str(self.config.provider_env_file),
                "-f",
                str(self.config.compose_files[0]),
                "-f",
                str(self.config.compose_files[1]),
                *tail,
            ],
            failure=failure,
            timeout=180,
        )

    def check_readers(self, containers: list[Json], permitted: set[str]) -> None:
        volumes = {self.config.project_name + "_" + name for name in self.config.volume_names}
        for item in containers:
            status = item.get("State", {}).get("Status")
            if (
                status not in {"exited", "dead"}
                and item.get("Id") not in permitted
                and any(
                    mount.get("Type") == "volume" and mount.get("Name") in volumes
                    for mount in item.get("Mounts", [])
                )
            ):
                raise RunnerError("child_unresolved")

    def stopped(self) -> None:
        values = self.inventory()
        source = [
            item
            for item in values
            if self.labels(item).get("com.docker.compose.project") == self.config.project_name
        ]
        if any(item.get("State", {}).get("Status") != "exited" for item in source):
            raise RunnerError("backup_interrupted")
        self.check_readers(values, set())

    def start_existing(self, journal: Json, services: set[str]) -> None:
        from operations.backups.docker import start_existing

        start_existing(self, journal, services)

    def resume(self, journal: Json) -> None:
        from operations.backups.docker import resume_existing

        resume_existing(self, journal)
