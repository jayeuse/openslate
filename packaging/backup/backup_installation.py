"""Create and verify an encrypted OpenSlate installation backup.

This module deliberately has no FastAPI imports.  An operator invokes it only
after placing the API and scanner in the documented stopped maintenance state.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PureWindowsPath
from urllib.parse import unquote, urlsplit

_CONFIG_FIELDS = frozenset(
    {
        "version",
        "installation_id",
        "database_url",
        "pg_password_file",
        "restic_repository",
        "restic_password_file",
        "staging_directory",
        "completion_marker",
        "maintenance_state_file",
        "maintenance_lock_file",
        "maintenance_max_age_seconds",
        "private_file_roots",
        "initialize_repository",
    }
)
_SNAPSHOT_ID = re.compile(r"^[0-9a-f]{8,64}$")
_SCHEMA_REVISION = re.compile(r"^[0-9A-Za-z_.-]{1,128}$")
_INSTALLATION_ID = re.compile(r"^[0-9a-f]{8,64}$")
_CommandRunner = Callable[..., subprocess.CompletedProcess[str]]


class BackupError(RuntimeError):
    """An unsafe or incomplete backup operation."""


@dataclass(frozen=True)
class DatabaseTarget:
    url: str
    host: str
    port: int
    database: str
    username: str


@dataclass(frozen=True)
class BackupConfig:
    installation_id: str
    database: DatabaseTarget
    pg_password_file: Path
    restic_repository: Path
    restic_password_file: Path
    staging_directory: Path
    completion_marker: Path
    maintenance_state_file: Path
    maintenance_lock_file: Path
    maintenance_max_age_seconds: int
    private_file_roots: tuple[Path, ...]
    initialize_repository: bool

    @staticmethod
    def _is_absolute_path(value: str, *, platform_name: str | None = None) -> bool:
        platform = platform_name or sys.platform
        if platform.startswith("win"):
            return PureWindowsPath(value).is_absolute()
        return Path(value).is_absolute()


@dataclass(frozen=True)
class BackupResult:
    snapshot_id: str
    manifest_sha256: str
    completed_at: str


def _expect_string(value: object, name: str) -> str:
    if not isinstance(value, str) or not value or value.strip() != value or "\x00" in value:
        raise BackupError(f"{name} must be a non-empty string")
    return value


def _no_control_characters(value: str, name: str) -> str:
    if any(character in value for character in ("\r", "\n", "\x00")):
        raise BackupError(f"{name} cannot contain CR, LF, or NUL")
    return value


def _native_path(value: object, name: str, *, platform_name: str | None = None) -> Path:
    text = _expect_string(value, name)
    if not BackupConfig._is_absolute_path(text, platform_name=platform_name):
        raise BackupError(f"{name} must be an absolute path")
    return Path(text)


def _parse_database_url(value: object) -> DatabaseTarget:
    url = _expect_string(value, "database_url")
    if any(character.isspace() for character in url):
        raise BackupError("database_url cannot contain whitespace")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as error:
        raise BackupError("database_url has an invalid host or port") from error
    if parsed.scheme != "postgresql":
        raise BackupError("database_url must be a PostgreSQL psycopg URL")
    if parsed.password is not None:
        raise BackupError("database_url must not contain a password")
    if not parsed.hostname or not parsed.username or parsed.fragment or parsed.query:
        raise BackupError("database_url must contain host and username without query or fragment")
    if "%" in parsed.hostname:
        raise BackupError("database host cannot use percent encoding")
    host = _no_control_characters(parsed.hostname, "database host")
    username = _no_control_characters(unquote(parsed.username), "database username")
    database = _no_control_characters(unquote(parsed.path.lstrip("/")), "database name")
    if not database or "/" in database or "\\" in database:
        raise BackupError("database_url must name exactly one database")
    return DatabaseTarget(
        url=url,
        host=host,
        port=port or 5432,
        database=database,
        username=username,
    )


def _parse_repository(value: object, *, platform_name: str | None = None) -> Path:
    repository = _native_path(value, "restic_repository", platform_name=platform_name)
    if "@" in str(repository) or "://" in str(repository):
        raise BackupError("restic_repository must be a local absolute path")
    return repository


def parse_config(path: Path, *, platform_name: str | None = None) -> BackupConfig:
    """Read a strict, secret-free installation operations configuration."""

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BackupError("cannot read backup configuration") from error
    if not isinstance(raw, dict) or frozenset(raw) != _CONFIG_FIELDS:
        raise BackupError("backup configuration must contain exactly the documented fields")
    if raw["version"] != 1:
        raise BackupError("backup configuration version must be 1")
    roots = raw["private_file_roots"]
    if not isinstance(roots, list) or not roots:
        raise BackupError("private_file_roots must contain at least one path")
    if not isinstance(raw["initialize_repository"], bool):
        raise BackupError("initialize_repository must be a boolean")
    installation_id = _expect_string(raw["installation_id"], "installation_id")
    if not _INSTALLATION_ID.fullmatch(installation_id):
        raise BackupError("installation_id must be a lowercase hexadecimal identifier")
    max_age = raw["maintenance_max_age_seconds"]
    if not isinstance(max_age, int) or isinstance(max_age, bool) or not 1 <= max_age <= 3600:
        raise BackupError("maintenance_max_age_seconds must be between 1 and 3600")
    return BackupConfig(
        installation_id=installation_id,
        database=_parse_database_url(raw["database_url"]),
        pg_password_file=_native_path(
            raw["pg_password_file"], "pg_password_file", platform_name=platform_name
        ),
        restic_repository=_parse_repository(raw["restic_repository"], platform_name=platform_name),
        restic_password_file=_native_path(
            raw["restic_password_file"], "restic_password_file", platform_name=platform_name
        ),
        staging_directory=_native_path(
            raw["staging_directory"], "staging_directory", platform_name=platform_name
        ),
        completion_marker=_native_path(
            raw["completion_marker"], "completion_marker", platform_name=platform_name
        ),
        maintenance_state_file=_native_path(
            raw["maintenance_state_file"], "maintenance_state_file", platform_name=platform_name
        ),
        maintenance_lock_file=_native_path(
            raw["maintenance_lock_file"], "maintenance_lock_file", platform_name=platform_name
        ),
        maintenance_max_age_seconds=max_age,
        private_file_roots=tuple(
            _native_path(item, "private_file_roots entry", platform_name=platform_name)
            for item in roots
        ),
        initialize_repository=raw["initialize_repository"],
    )


def _assert_no_symlink(path: Path, name: str) -> None:
    current = path
    while True:
        if current.is_symlink():
            raise BackupError(f"{name} cannot be a symlink or sit below one")
        if current.parent == current:
            return
        current = current.parent


def _assert_secure_ownership(details: os.stat_result, name: str, *, file: bool) -> None:
    if os.name == "nt":
        raise BackupError("Windows ACL verification is unavailable; refusing backup")
    owner = os.geteuid()
    if details.st_uid not in {0, owner}:
        raise BackupError(f"{name} has an unexpected owner")
    unsafe_mode = 0o077 if file else 0o022
    if details.st_mode & unsafe_mode:
        raise BackupError(f"{name} is not private")


def _assert_secure_ancestors(path: Path, name: str) -> None:
    current = path.parent
    while True:
        try:
            details = current.stat()
        except OSError as error:
            raise BackupError(f"{name} has an unreadable ancestor") from error
        if not stat.S_ISDIR(details.st_mode):
            raise BackupError(f"{name} has an invalid ancestor")
        _assert_secure_ownership(details, f"{name} ancestor", file=False)
        if current.parent == current:
            return
        current = current.parent


def _assert_private_file(path: Path, name: str) -> os.stat_result:
    _assert_no_symlink(path, name)
    _assert_secure_ancestors(path, name)
    try:
        details = path.stat()
    except OSError as error:
        raise BackupError(f"{name} cannot be read") from error
    if not stat.S_ISREG(details.st_mode):
        raise BackupError(f"{name} must be a regular file")
    _assert_secure_ownership(details, name, file=True)
    return details


def _assert_safe_directory(path: Path, name: str) -> Path:
    _assert_no_symlink(path, name)
    _assert_secure_ancestors(path, name)
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise BackupError(f"{name} does not exist") from error
    if not resolved.is_dir() or resolved.parent == resolved:
        raise BackupError(f"{name} must be a non-root directory")
    _assert_no_symlink(resolved, name)
    try:
        _assert_secure_ownership(resolved.stat(), name, file=False)
    except OSError as error:
        raise BackupError(f"{name} cannot be read") from error
    return resolved


@dataclass
class DirectoryGuard:
    """A directory handle retained while a sensitive operation uses that location."""

    path: Path
    descriptor: int
    identity: tuple[int, int]
    name: str

    @classmethod
    def acquire(cls, path: Path, name: str) -> DirectoryGuard:
        secured = _assert_safe_directory(path, name)
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(secured, flags)
        except OSError as error:
            raise BackupError(f"cannot retain {name} handle") from error
        details = os.fstat(descriptor)
        return cls(secured, descriptor, (details.st_dev, details.st_ino), name)

    def revalidate(self) -> None:
        try:
            details = os.fstat(self.descriptor)
            current = self.path.stat()
        except OSError as error:
            raise BackupError(f"{self.name} changed during backup") from error
        opened_identity = (details.st_dev, details.st_ino)
        current_identity = (current.st_dev, current.st_ino)
        if opened_identity != self.identity or current_identity != self.identity:
            raise BackupError(f"{self.name} changed during backup")
        _assert_safe_directory(self.path, self.name)

    def close(self) -> None:
        with contextlib.suppress(OSError):
            os.close(self.descriptor)


def _safe_open(path: Path, name: str, *, writable: bool = False) -> int:
    flags = os.O_RDWR if writable else os.O_RDONLY
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise BackupError(f"cannot open {name}") from error
    try:
        details = os.fstat(descriptor)
        current = path.stat()
        if not stat.S_ISREG(details.st_mode) or (details.st_dev, details.st_ino) != (
            current.st_dev,
            current.st_ino,
        ):
            raise BackupError(f"{name} changed while it was opened")
        _assert_private_file(path, name)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _read_descriptor(descriptor: int, name: str) -> bytes:
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        while chunk := os.read(descriptor, 4096):
            chunks.append(chunk)
            if sum(len(part) for part in chunks) > 16384:
                raise BackupError(f"{name} is too large")
    except OSError as error:
        raise BackupError(f"cannot read {name}") from error
    return b"".join(chunks)


def _assert_descriptor_current(descriptor: int, path: Path, name: str) -> None:
    try:
        opened = os.fstat(descriptor)
        current = path.stat()
    except OSError as error:
        raise BackupError(f"{name} changed during backup") from error
    if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
        raise BackupError(f"{name} changed during backup")


def _parse_maintenance_state(
    raw: bytes, config: BackupConfig, now: datetime, *, require_fresh: bool
) -> None:
    try:
        state = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BackupError("cannot read maintenance state") from error
    if not isinstance(state, dict) or set(state) != {
        "installation_id",
        "maintenance",
        "fastapi",
        "scanner",
        "issued_at",
    }:
        raise BackupError("maintenance state has an invalid format")
    if (
        state["installation_id"] != config.installation_id
        or state["maintenance"] is not True
        or state["fastapi"] != "stopped"
        or state["scanner"] != "stopped"
        or not isinstance(state["issued_at"], str)
    ):
        raise BackupError("FastAPI and scanner must be stopped in maintenance state before backup")
    try:
        issued_at = datetime.fromisoformat(state["issued_at"].replace("Z", "+00:00"))
    except ValueError as error:
        raise BackupError("maintenance state issued_at is invalid") from error
    if issued_at.tzinfo is None:
        raise BackupError("maintenance state issued_at must include a timezone")
    if require_fresh:
        age = (now.astimezone(UTC) - issued_at.astimezone(UTC)).total_seconds()
        if age < -30 or age > config.maintenance_max_age_seconds:
            raise BackupError("maintenance state is stale or from the future")


@dataclass
class MaintenanceLease:
    """A held advisory lock that every local service must respect before resuming."""

    config: BackupConfig
    state_path: Path
    lock_path: Path
    state_descriptor: int
    lock_descriptor: int
    state_digest: str
    lock_digest: str
    now: Callable[[], datetime]

    @classmethod
    def acquire(cls, config: BackupConfig, now: Callable[[], datetime]) -> MaintenanceLease:
        _assert_private_file(config.maintenance_state_file, "maintenance_state_file")
        _assert_private_file(config.maintenance_lock_file, "maintenance_lock_file")
        state_descriptor = _safe_open(config.maintenance_state_file, "maintenance_state_file")
        try:
            lock_descriptor = _safe_open(
                config.maintenance_lock_file, "maintenance_lock_file", writable=True
            )
        except Exception:
            os.close(state_descriptor)
            raise
        try:
            if os.name == "nt":
                raise BackupError(
                    "Windows maintenance lock verification is unavailable; refusing backup"
                )
            import fcntl

            try:
                fcntl.flock(lock_descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise BackupError("backup already in progress") from error
            except OSError as error:
                raise BackupError("cannot acquire maintenance lock") from error
            state = _read_descriptor(state_descriptor, "maintenance_state_file")
            lock = _read_descriptor(lock_descriptor, "maintenance_lock_file")
            _parse_maintenance_state(state, config, now(), require_fresh=True)
            if lock != (config.installation_id + "\n").encode("ascii"):
                raise BackupError("maintenance lock is not bound to this installation")
            return cls(
                config=config,
                state_path=config.maintenance_state_file,
                lock_path=config.maintenance_lock_file,
                state_descriptor=state_descriptor,
                lock_descriptor=lock_descriptor,
                state_digest=hashlib.sha256(state).hexdigest(),
                lock_digest=hashlib.sha256(lock).hexdigest(),
                now=now,
            )
        except Exception:
            with contextlib.suppress(OSError):
                os.close(lock_descriptor)
            os.close(state_descriptor)
            raise

    def revalidate(self) -> None:
        _assert_private_file(self.state_path, "maintenance_state_file")
        _assert_private_file(self.lock_path, "maintenance_lock_file")
        _assert_descriptor_current(self.state_descriptor, self.state_path, "maintenance_state_file")
        _assert_descriptor_current(self.lock_descriptor, self.lock_path, "maintenance_lock_file")
        state = _read_descriptor(self.state_descriptor, "maintenance_state_file")
        lock = _read_descriptor(self.lock_descriptor, "maintenance_lock_file")
        _parse_maintenance_state(state, self.config, self.now(), require_fresh=False)
        state_digest = hashlib.sha256(state).hexdigest()
        lock_digest = hashlib.sha256(lock).hexdigest()
        if state_digest != self.state_digest or lock_digest != self.lock_digest:
            raise BackupError("maintenance proof changed during backup")

    def close(self) -> None:
        with contextlib.suppress(OSError):
            import fcntl

            fcntl.flock(self.lock_descriptor, fcntl.LOCK_UN)
        with contextlib.suppress(OSError):
            os.close(self.lock_descriptor)
        with contextlib.suppress(OSError):
            os.close(self.state_descriptor)


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
    except ValueError:
        return False
    return True


def _validate_runtime_paths(
    config: BackupConfig, config_path: Path
) -> tuple[Path, tuple[Path, ...], Path]:
    _assert_private_file(config_path, "backup configuration")
    _assert_private_file(config.pg_password_file, "pg_password_file")
    _assert_private_file(config.restic_password_file, "restic_password_file")
    staging = _assert_safe_directory(config.staging_directory, "staging_directory")
    repository = _assert_safe_directory(config.restic_repository, "restic_repository")
    password_files = (
        config.pg_password_file.resolve(strict=True),
        config.restic_password_file.resolve(strict=True),
    )
    if any(_is_within(password_file, repository) for password_file in password_files):
        raise BackupError("password files cannot be inside restic_repository")
    roots = tuple(
        _assert_safe_directory(root, "private_file_root") for root in config.private_file_roots
    )
    marker_parent = _assert_safe_directory(
        config.completion_marker.parent, "completion_marker parent"
    )
    _assert_no_symlink(config.completion_marker, "completion_marker")
    protected_inputs = {
        config_path.resolve(strict=True),
        config.pg_password_file.resolve(strict=True),
        config.restic_password_file.resolve(strict=True),
        config.maintenance_state_file.resolve(strict=True),
        config.maintenance_lock_file.resolve(strict=True),
    }
    marker = config.completion_marker.resolve(strict=False)
    if marker in protected_inputs:
        raise BackupError("completion_marker must be distinct from protected operation inputs")
    if config.completion_marker.exists():
        raise BackupError("completion_marker already exists and will not be overwritten")
    if any(_is_within(root, staging) or _is_within(staging, root) for root in roots):
        raise BackupError("staging_directory cannot overlap a private file root")
    if any(_is_within(repository, root) or _is_within(root, repository) for root in roots):
        raise BackupError("restic_repository cannot overlap a private file root")
    if _is_within(repository, staging) or _is_within(staging, repository):
        raise BackupError("restic_repository cannot overlap staging_directory")
    if not _is_within(marker, marker_parent):
        raise BackupError("completion_marker must be directly contained by its parent")
    if any(_is_within(marker, protected) for protected in (*roots, staging, repository)):
        raise BackupError("completion_marker cannot be inside backup sources or staging")
    return staging, roots, repository


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _tree_hash(root: Path) -> tuple[str, int, int]:
    digest = hashlib.sha256()
    file_count = 0
    total_bytes = 0
    def relative_name(candidate: Path) -> str:
        return candidate.relative_to(root).as_posix()

    candidates = sorted(root.rglob("*"), key=relative_name)
    for item in candidates:
        if item.is_symlink():
            raise BackupError("private file roots cannot contain symlinks")
        if item.is_dir():
            continue
        if not item.is_file():
            raise BackupError("private file roots can contain only regular files and directories")
        relative = item.relative_to(root).as_posix().encode("utf-8")
        item_hash = _sha256(item).encode("ascii")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(item_hash)
        size = item.stat().st_size
        digest.update(size.to_bytes(8, "big"))
        file_count += 1
        total_bytes += size
    return digest.hexdigest(), file_count, total_bytes


def _escaped_pgpass(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", "\\:")


def _pgpass_field(value: str, name: str) -> str:
    value = _no_control_characters(value, name)
    if not value:
        raise BackupError(f"{name} cannot be empty")
    return value


def _write_pgpass(config: BackupConfig, directory: Path) -> Path:
    try:
        password = config.pg_password_file.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise BackupError("cannot read pg_password_file") from error
    if password.endswith("\r\n"):
        password = password[:-2]
    elif password.endswith("\n"):
        password = password[:-1]
    password = _pgpass_field(password, "pg_password_file")
    descriptor, raw_path = tempfile.mkstemp(prefix="pgpass-", dir=directory)
    pgpass = Path(raw_path)
    try:
        if os.name == "nt":
            os.chmod(pgpass, stat.S_IREAD | stat.S_IWRITE)
        else:
            os.fchmod(descriptor, 0o600)
        line = ":".join(
            _escaped_pgpass(value)
            for value in (
                _pgpass_field(config.database.host, "database host"),
                _pgpass_field(str(config.database.port), "database port"),
                _pgpass_field(config.database.database, "database name"),
                _pgpass_field(config.database.username, "database username"),
                password,
            )
        )
        os.write(descriptor, (line + "\n").encode("utf-8"))
    finally:
        os.close(descriptor)
    return pgpass


def _run(
    command_runner: _CommandRunner, args: Sequence[str], *, env: Mapping[str, str], label: str
) -> subprocess.CompletedProcess[str]:
    try:
        result = command_runner(list(args), env=dict(env))
    except OSError as error:
        raise BackupError(f"{label} is unavailable") from error
    if result.returncode != 0:
        raise BackupError(f"{label} failed")
    return result


def _subprocess_runner(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=False, capture_output=True, text=True, env=env)


def _minimal_environment() -> dict[str, str]:
    names = {"PATH"}
    if os.name == "nt":
        names.update({"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"})
    return {name: os.environ[name] for name in names if name in os.environ}


def _pg_environment(pgpass: Path) -> dict[str, str]:
    environment = _minimal_environment()
    environment["PGPASSFILE"] = str(pgpass)
    environment["PGCONNECT_TIMEOUT"] = "15"
    return environment


def _restic_environment(config: BackupConfig) -> dict[str, str]:
    environment = _minimal_environment()
    environment["RESTIC_REPOSITORY"] = str(config.restic_repository)
    environment["RESTIC_PASSWORD_FILE"] = str(config.restic_password_file)
    return environment


def _run_with_lease(
    lease: MaintenanceLease,
    command_runner: _CommandRunner,
    args: Sequence[str],
    *,
    env: Mapping[str, str],
    label: str,
    guards: Sequence[DirectoryGuard] = (),
) -> subprocess.CompletedProcess[str]:
    lease.revalidate()
    for guard in guards:
        guard.revalidate()
    result = _run(command_runner, args, env=env, label=label)
    lease.revalidate()
    for guard in guards:
        guard.revalidate()
    return result


def _repository_initialized(
    lease: MaintenanceLease,
    command_runner: _CommandRunner,
    config: BackupConfig,
    guards: Sequence[DirectoryGuard],
) -> bool:
    environment = _restic_environment(config)
    lease.revalidate()
    for guard in guards:
        guard.revalidate()
    try:
        result = command_runner(["restic", "cat", "config", "--json"], env=environment)
    except OSError as error:
        raise BackupError("restic is unavailable") from error
    lease.revalidate()
    for guard in guards:
        guard.revalidate()
    return result.returncode == 0


def _read_alembic_revision(
    lease: MaintenanceLease,
    command_runner: _CommandRunner,
    config: BackupConfig,
    pgpass: Path,
    guards: Sequence[DirectoryGuard],
) -> str:
    """Read the one schema revision that the backup actually contains."""

    result = _run_with_lease(
        lease,
        command_runner,
        [
            "psql",
            "--no-psqlrc",
            "--tuples-only",
            "--no-align",
            "--dbname",
            config.database.url,
            "--command",
            "SELECT version_num FROM alembic_version",
        ],
        env=_pg_environment(pgpass),
        label="Alembic revision lookup",
        guards=guards,
    )
    revisions = [line for line in result.stdout.splitlines() if line]
    if (
        len(revisions) != 1
        or revisions[0] == "replace-with-current-alembic-revision"
        or not _SCHEMA_REVISION.fullmatch(revisions[0])
    ):
        raise BackupError("Alembic revision lookup returned an invalid result")
    return revisions[0]


def _snapshot_id(output: str) -> str:
    for line in output.splitlines():
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        value = payload.get("snapshot_id") if isinstance(payload, dict) else None
        if isinstance(value, str) and _SNAPSHOT_ID.fullmatch(value):
            return value
    raise BackupError("restic backup did not return a snapshot identifier")


def _restored_path(target: Path, source: Path) -> Path:
    return target / source.relative_to(source.anchor)


def _write_manifest(
    path: Path,
    *,
    config: BackupConfig,
    dump: Path,
    roots: tuple[Path, ...],
    created_at: str,
    schema_revision: str,
) -> str:
    inventories = []
    for root in roots:
        root_hash, file_count, total_bytes = _tree_hash(root)
        inventories.append(
            {
                "root_id": hashlib.sha256(str(root).encode("utf-8")).hexdigest(),
                "tree_sha256": root_hash,
                "file_count": file_count,
                "total_bytes": total_bytes,
            }
        )
    payload = {
        "format_version": 1,
        "created_at": created_at,
        "schema_revision": schema_revision,
        "database": {
            "host": config.database.host,
            "port": config.database.port,
            "database": config.database.database,
            "username": config.database.username,
        },
        "dump": {"format": "pg_dump_custom", "sha256": _sha256(dump), "bytes": dump.stat().st_size},
        "private_file_roots": inventories,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
    path.write_bytes(encoded)
    return hashlib.sha256(encoded).hexdigest()


def _atomic_marker(path: Path, result: BackupResult) -> None:
    payload = json.dumps(
        {
            "format_version": 1,
            "snapshot_id": result.snapshot_id,
            "manifest_sha256": result.manifest_sha256,
            "completed_at": result.completed_at,
            "backup_verified": True,
            "verification_scope": (
                "repository-check, manifest-and-dump-restore-hashes, pg-restore-list"
            ),
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8") + b"\n"
    descriptor, temp_name = tempfile.mkstemp(prefix=".backup-marker-", dir=path.parent)
    temporary = Path(temp_name)
    try:
        if os.name == "nt":
            os.chmod(temporary, stat.S_IREAD | stat.S_IWRITE)
        else:
            os.fchmod(descriptor, 0o600)
        os.write(descriptor, payload)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _cleanup_run_directory(run_directory: Path, pgpass: Path | None) -> None:
    """Remove sensitive stage artifacts before any success marker is published."""

    failures: list[OSError] = []
    targets = [pgpass, run_directory / "database.dump", run_directory / "manifest.json"]
    for target in targets:
        if target is None:
            continue
        try:
            target.unlink(missing_ok=True)
        except OSError as error:
            failures.append(error)
    restore = run_directory / "restore"
    try:
        if restore.exists():
            shutil.rmtree(restore)
        if run_directory.exists():
            shutil.rmtree(run_directory)
    except OSError as error:
        failures.append(error)
    if run_directory.exists() or failures:
        raise BackupError("backup staging cleanup failed")


def run_backup(
    config_path: Path,
    *,
    command_runner: _CommandRunner = _subprocess_runner,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
) -> BackupResult:
    """Create one restic snapshot and prove its database artifacts can be restored."""

    config = parse_config(config_path)
    staging_root, roots, repository = _validate_runtime_paths(config, config_path)
    lease = MaintenanceLease.acquire(config, now)
    staging_guard: DirectoryGuard | None = None
    repository_guard: DirectoryGuard | None = None
    marker_guard: DirectoryGuard | None = None
    try:
        staging_guard = DirectoryGuard.acquire(staging_root, "staging_directory")
        repository_guard = DirectoryGuard.acquire(repository, "restic_repository")
        marker_guard = DirectoryGuard.acquire(
            config.completion_marker.parent, "completion_marker parent"
        )
    except Exception:
        for guard in (marker_guard, repository_guard, staging_guard):
            if guard is not None:
                guard.close()
        lease.close()
        raise
    assert staging_guard is not None and repository_guard is not None and marker_guard is not None
    guards = (staging_guard, repository_guard, marker_guard)
    run_directory = Path()
    pgpass: Path | None = None
    try:
        staging_guard.revalidate()
        run_directory = Path(tempfile.mkdtemp(prefix="openslate-backup-", dir=staging_guard.path))
        repository_guard.revalidate()
        marker_guard.revalidate()
        run_directory.chmod(0o700)
        dump = run_directory / "database.dump"
        manifest = run_directory / "manifest.json"
        pgpass = _write_pgpass(config, run_directory)
        schema_revision = _read_alembic_revision(lease, command_runner, config, pgpass, guards)
        _run_with_lease(
            lease,
            command_runner,
            [
                "pg_dump",
                "--format=custom",
                "--file",
                str(dump),
                "--no-owner",
                "--no-privileges",
                "--dbname",
                config.database.url,
            ],
            env=_pg_environment(pgpass),
            label="pg_dump",
            guards=guards,
        )
        dump_revision = _read_alembic_revision(lease, command_runner, config, pgpass, guards)
        if dump_revision != schema_revision:
            raise BackupError("Alembic revision changed while creating database dump")
        completed_at = now().astimezone(UTC).isoformat().replace("+00:00", "Z")
        manifest_hash = _write_manifest(
            manifest,
            config=config,
            dump=dump,
            roots=roots,
            created_at=completed_at,
            schema_revision=schema_revision,
        )
        restic_environment = _restic_environment(config)
        if not _repository_initialized(lease, command_runner, config, guards):
            if not config.initialize_repository:
                raise BackupError("restic repository is not initialized")
            _run_with_lease(
                lease,
                command_runner,
                ["restic", "init"],
                env=restic_environment,
                label="restic init",
                guards=guards,
            )
            if not _repository_initialized(lease, command_runner, config, guards):
                raise BackupError("restic repository initialization could not be verified")
        backup = _run_with_lease(
            lease,
            command_runner,
            [
                "restic",
                "backup",
                "--json",
                str(dump),
                str(manifest),
                *(str(root) for root in roots),
            ],
            env=restic_environment,
            label="restic backup",
            guards=guards,
        )
        snapshot_id = _snapshot_id(backup.stdout)
        _run_with_lease(
            lease,
            command_runner,
            ["restic", "check"],
            env=restic_environment,
            label="restic check",
            guards=guards,
        )
        restore_root = run_directory / "restore"
        restore_root.mkdir(mode=0o700)
        _run_with_lease(
            lease,
            command_runner,
            [
                "restic",
                "restore",
                snapshot_id,
                "--target",
                str(restore_root),
                "--include",
                str(dump),
                "--include",
                str(manifest),
            ],
            env=restic_environment,
            label="restic restore verification",
            guards=guards,
        )
        restored_dump = _restored_path(restore_root, dump)
        restored_manifest = _restored_path(restore_root, manifest)
        if not restored_dump.is_file() or not restored_manifest.is_file():
            raise BackupError("restic restore verification did not restore required artifacts")
        if _sha256(restored_dump) != _sha256(dump) or _sha256(restored_manifest) != manifest_hash:
            raise BackupError("restic restore verification hash mismatch")
        _run_with_lease(
            lease,
            command_runner,
            ["pg_restore", "--list", str(restored_dump)],
            env=_minimal_environment(),
            label="pg_restore validation",
            guards=guards,
        )
        result = BackupResult(
            snapshot_id=snapshot_id,
            manifest_sha256=manifest_hash,
            completed_at=completed_at,
        )
        lease.revalidate()
        staging_guard.revalidate()
        _cleanup_run_directory(run_directory, pgpass)
        run_directory = Path()
        lease.revalidate()
        repository_guard.revalidate()
        marker_guard.revalidate()
        _atomic_marker(config.completion_marker, result)
        return result
    finally:
        try:
            if run_directory != Path():
                _cleanup_run_directory(run_directory, pgpass)
        finally:
            marker_guard.close()
            repository_guard.close()
            staging_guard.close()
            lease.close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config", required=True, type=Path, help="Protected local backup config JSON"
    )
    args = parser.parse_args(argv)
    try:
        result = run_backup(args.config)
    except BackupError as error:
        print(f"Backup failed: {error}", file=sys.stderr)
        return 1
    print(f"Backup complete: snapshot {result.snapshot_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
