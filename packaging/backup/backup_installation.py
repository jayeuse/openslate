"""Offline, encrypted backup of one self-hosted Supabase installation.

The operator stops every installation container first. This command only reads
the owned volumes, writes a single Restic snapshot, and verifies that snapshot.
"""

from __future__ import annotations

import argparse
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
from pathlib import Path
from typing import cast

_FIELDS = {
    "version",
    "installation_id",
    "project_name",
    "deployment",
    "compose_root",
    "provider_env_file",
    "app_env_file",
    "caddy_config_file",
    "tls_directory",
    "restic_repository",
    "restic_password_file",
    "staging_directory",
    "completion_marker",
}
_PROJECT = re.compile(r"^[a-z][a-z0-9_-]{1,62}$")
_IDENTITY = re.compile(r"^[a-z0-9][a-z0-9_-]{1,62}$")
_SNAPSHOT = re.compile(r"^[0-9a-f]{64}$")
_BASE_VOLUMES = (
    "supabase-db-data",
    "supabase-db-config",
    "supabase-storage-data",
    "supabase-studio-snippets",
)
_BASE_SERVICES = {
    "db",
    "auth",
    "rest",
    "storage",
    "imgproxy",
    "meta",
    "studio",
    "api-gw",
    "provider-volume-init",
}
_PRODUCTION_SERVICES = {"api", "scanner-worker", "clamav", "caddy"}


class BackupError(RuntimeError):
    """An installation backup or restore safety condition was not met."""


@dataclass(frozen=True)
class BackupConfig:
    installation_id: str
    project_name: str
    deployment: str
    compose_root: Path
    provider_env_file: Path
    app_env_file: Path | None
    caddy_config_file: Path | None
    tls_directory: Path | None
    restic_repository: Path
    restic_password_file: Path
    staging_directory: Path
    completion_marker: Path

    @property
    def volume_names(self) -> tuple[str, ...]:
        return (*_BASE_VOLUMES, *(("caddy-data",) if self.deployment == "production" else ()))

    @property
    def compose_files(self) -> tuple[Path, Path]:
        overlay = (
            "compose.production.yaml" if self.deployment == "production" else "compose.dev.yaml"
        )
        return self.compose_root / "compose.yaml", self.compose_root / overlay


@dataclass(frozen=True)
class BackupResult:
    snapshot_id: str
    manifest_sha256: str
    completed_at: str


def _absolute(value: object, label: str) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise BackupError(f"{label} must be an absolute path")
    path = Path(value)
    if not path.is_absolute():
        raise BackupError(f"{label} must be an absolute path")
    return path


def _optional_path(value: object, label: str) -> Path | None:
    return None if value is None else _absolute(value, label)


def parse_config(path: Path) -> BackupConfig:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BackupError("cannot read backup configuration") from error
    if not isinstance(raw, dict) or set(raw) != _FIELDS:
        raise BackupError("backup configuration must contain exactly the version 3 fields")
    if type(raw["version"]) is not int or raw["version"] != 3:
        raise BackupError("only Supabase backup configuration version 3 is supported")
    identity = raw["installation_id"]
    project = raw["project_name"]
    deployment = raw["deployment"]
    if not isinstance(identity, str) or not _IDENTITY.fullmatch(identity):
        raise BackupError("installation_id is invalid")
    if not isinstance(project, str) or not _PROJECT.fullmatch(project):
        raise BackupError("project_name is invalid")
    if deployment not in {"development", "production"}:
        raise BackupError("deployment must be development or production")
    config = BackupConfig(
        installation_id=identity,
        project_name=project,
        deployment=deployment,
        compose_root=_absolute(raw["compose_root"], "compose_root"),
        provider_env_file=_absolute(raw["provider_env_file"], "provider_env_file"),
        app_env_file=_optional_path(raw["app_env_file"], "app_env_file"),
        caddy_config_file=_optional_path(raw["caddy_config_file"], "caddy_config_file"),
        tls_directory=_optional_path(raw["tls_directory"], "tls_directory"),
        restic_repository=_absolute(raw["restic_repository"], "restic_repository"),
        restic_password_file=_absolute(raw["restic_password_file"], "restic_password_file"),
        staging_directory=_absolute(raw["staging_directory"], "staging_directory"),
        completion_marker=_absolute(raw["completion_marker"], "completion_marker"),
    )
    if deployment == "production" and not all(
        (config.app_env_file, config.caddy_config_file, config.tls_directory)
    ):
        raise BackupError(
            "production backup requires app environment, Caddy configuration, and TLS directory"
        )
    if deployment == "development" and any(
        (config.app_env_file, config.caddy_config_file, config.tls_directory)
    ):
        raise BackupError("development backup cannot include production-only private material")
    return config


def _assert_no_symlink(path: Path, label: str) -> None:
    current = path
    while True:
        if current.is_symlink():
            raise BackupError(f"{label} cannot contain a symlink")
        if current.parent == current:
            return
        current = current.parent


def _private(path: Path, label: str, *, directory: bool) -> Path:
    if os.name == "nt":
        raise BackupError(
            "run the backup command in Linux or WSL2; native Windows ACL admission is unavailable"
        )
    _assert_no_symlink(path, label)
    try:
        details = path.stat()
    except OSError as error:
        raise BackupError(f"{label} is unavailable") from error
    if directory != stat.S_ISDIR(details.st_mode) or (
        not directory and not stat.S_ISREG(details.st_mode)
    ):
        raise BackupError(f"{label} has the wrong filesystem type")
    if details.st_uid not in {0, os.geteuid()} or details.st_mode & (0o022 if directory else 0o077):
        raise BackupError(f"{label} is not owner-controlled")
    return path.resolve(strict=True)


def _separate(config: BackupConfig, config_path: Path) -> None:
    sources = [config.provider_env_file, config.restic_password_file, config_path]
    sources.extend(path for path in (config.app_env_file, config.caddy_config_file) if path)
    directories = [config.compose_root, config.restic_repository, config.staging_directory]
    if config.tls_directory:
        directories.append(config.tls_directory)
    for source in sources:
        _private(source, source.name, directory=False)
    for directory in directories:
        _private(directory, directory.name, directory=True)
    _private(config.completion_marker.parent, "completion marker parent", directory=True)
    _assert_no_symlink(config.completion_marker, "completion marker")
    if config.completion_marker.exists():
        raise BackupError("completion marker already exists")
    resolved = [path.resolve() for path in sources + directories]
    if len(resolved) != len(set(resolved)):
        raise BackupError("backup inputs and operation directories must be distinct")
    repository = config.restic_repository.resolve()
    staging = config.staging_directory.resolve()
    if repository.is_relative_to(staging) or staging.is_relative_to(repository):
        raise BackupError("Restic repository and staging directory overlap")
    recursive_inputs = [config.compose_root.resolve()]
    if config.tls_directory:
        recursive_inputs.append(config.tls_directory.resolve())
    if any(
        operation.is_relative_to(source) or source.is_relative_to(operation)
        for operation in (repository, staging)
        for source in recursive_inputs
    ):
        raise BackupError("backup operation directories overlap recursively copied inputs")
    for source in sources:
        if source.resolve().is_relative_to(repository):
            raise BackupError("private inputs cannot be inside the Restic repository")
    if config.completion_marker.resolve().is_relative_to(
        repository
    ) or config.completion_marker.resolve().is_relative_to(staging):
        raise BackupError("completion marker cannot be inside the repository or staging directory")


def _env() -> dict[str, str]:
    return {key: os.environ[key] for key in ("PATH",) if key in os.environ}


def _command(
    args: list[str], *, env: Mapping[str, str] | None = None
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(args, env=dict(env or _env()), capture_output=True, check=False)


def _run(
    runner: Callable[..., subprocess.CompletedProcess[bytes]],
    args: list[str],
    label: str,
    *,
    env: Mapping[str, str] | None = None,
) -> bytes:
    try:
        result = runner(args, env=dict(env or _env()))
    except OSError as error:
        raise BackupError(f"{label} is unavailable") from error
    if result.returncode:
        raise BackupError(f"{label} failed")
    return result.stdout


def _json_output(data: bytes, label: str) -> object:
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BackupError(f"{label} returned invalid JSON") from error


def _docker_inventory(
    runner: Callable[..., subprocess.CompletedProcess[bytes]], noun: str, project: str
) -> list[dict[str, object]]:
    if noun == "container":
        names = _run(
            runner,
            ["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={project}"],
            "Docker container inventory",
        )
    elif noun == "volume":
        names = _run(
            runner,
            [
                "docker",
                "volume",
                "ls",
                "-q",
                "--filter",
                f"label=com.docker.compose.project={project}",
            ],
            "Docker volume inventory",
        )
    else:
        names = _run(
            runner,
            [
                "docker",
                "network",
                "ls",
                "-q",
                "--filter",
                f"label=com.docker.compose.project={project}",
            ],
            "Docker network inventory",
        )
    identifiers = [line for line in names.decode("ascii").splitlines() if line]
    if not identifiers:
        return []
    data = _json_output(
        _run(runner, ["docker", noun, "inspect", *identifiers], f"Docker {noun} inspect"),
        f"Docker {noun} inspect",
    )
    if (
        not isinstance(data, list)
        or len(data) != len(identifiers)
        or any(not isinstance(item, dict) for item in data)
    ):
        raise BackupError(f"Docker {noun} inventory is inconsistent")
    return data


def _labels(item: Mapping[str, object], *, container: bool) -> dict[str, str]:
    config = item.get("Config") if container else item
    if not isinstance(config, dict) or not isinstance(config.get("Labels"), dict):
        raise BackupError("Docker resource labels are unavailable")
    labels = config["Labels"]
    if any(not isinstance(key, str) or not isinstance(value, str) for key, value in labels.items()):
        raise BackupError("Docker resource labels are invalid")
    return cast(dict[str, str], labels)


def _project_inventory(
    config: BackupConfig, runner: Callable[..., subprocess.CompletedProcess[bytes]]
) -> dict[str, object]:
    containers = _docker_inventory(runner, "container", config.project_name)
    volumes = _docker_inventory(runner, "volume", config.project_name)
    expected_services = _BASE_SERVICES | (
        _PRODUCTION_SERVICES if config.deployment == "production" else {"mailpit"}
    )
    services: dict[str, dict[str, str]] = {}
    for item in containers:
        labels = _labels(item, container=True)
        service = labels.get("com.docker.compose.service")
        state = item.get("State")
        container_config = item.get("Config")
        image_ref = container_config.get("Image") if isinstance(container_config, dict) else None
        image_id = item.get("Image")
        if (
            labels.get("com.docker.compose.project") != config.project_name
            or service not in expected_services
            or service in services
        ):
            raise BackupError("source project has unexpected containers")
        if not isinstance(state, dict) or state.get("Status") != "exited":
            raise BackupError(
                "all source-project containers, including PostgreSQL, must be stopped"
            )
        if (
            not isinstance(image_ref, str)
            or not image_ref
            or not isinstance(image_id, str)
            or not image_id.startswith("sha256:")
        ):
            raise BackupError("source container image identity is unavailable")
        services[service] = {"ref": image_ref, "id": image_id}
    if set(services) != expected_services:
        raise BackupError("source project service inventory is incomplete")
    owned: dict[str, str] = {}
    for item in volumes:
        labels = _labels(item, container=False)
        logical = labels.get("com.docker.compose.volume")
        name = item.get("Name")
        if (
            labels.get("com.docker.compose.project") != config.project_name
            or logical not in config.volume_names
            or name != f"{config.project_name}_{logical}"
            or logical in owned
        ):
            raise BackupError("source project has unexpected named volumes")
        owned[logical] = name
    if set(owned) != set(config.volume_names):
        raise BackupError("source project durable volume inventory is incomplete")
    return {"services": services, "volumes": owned}


def _compose_images(
    config: BackupConfig, runner: Callable[..., subprocess.CompletedProcess[bytes]]
) -> dict[str, str]:
    base, overlay = config.compose_files
    data = _json_output(
        _run(
            runner,
            [
                "docker",
                "compose",
                "--project-name",
                config.project_name,
                "--env-file",
                str(config.provider_env_file),
                "-f",
                str(base),
                "-f",
                str(overlay),
                "config",
                "--format",
                "json",
            ],
            "Compose configuration",
        ),
        "Compose configuration",
    )
    if not isinstance(data, dict) or not isinstance(data.get("services"), dict):
        raise BackupError("Compose service inventory is invalid")
    images: dict[str, str] = {}
    for service, service_config in data["services"].items():
        if (
            not isinstance(service, str)
            or not isinstance(service_config, dict)
            or not isinstance(service_config.get("image"), str)
        ):
            raise BackupError("Compose service image is invalid")
        images[service] = service_config["image"]
    return images


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _copy_file(source: Path, target: Path, *, private: bool) -> None:
    if private:
        _private(source, source.name, directory=False)
    elif not source.is_file() or source.is_symlink():
        raise BackupError("Compose asset is not a regular file")
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with source.open("rb") as incoming, target.open("xb") as outgoing:
        shutil.copyfileobj(incoming, outgoing)
    target.chmod(0o600)


def _copy_directory(source: Path, target: Path, *, private: bool) -> None:
    if private:
        _private(source, source.name, directory=True)
    elif not source.is_dir() or source.is_symlink():
        raise BackupError("Compose asset directory is invalid")
    target.mkdir(mode=0o700, parents=True)
    for item in source.rglob("*"):
        _assert_no_symlink(item, item.name)
        destination = target / item.relative_to(source)
        if item.is_dir():
            destination.mkdir(mode=0o700, parents=True, exist_ok=True)
        elif item.is_file():
            _copy_file(item, destination, private=private)
        else:
            raise BackupError("private directory contains unsupported entries")


def _export_volume(volume: str, image: str, destination: Path) -> None:
    # PostgreSQL and provider users own private files; the source mount stays read-only.
    args = [
        "docker",
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "DAC_READ_SEARCH",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "0:0",
        "--mount",
        f"type=volume,source={volume},target=/source,readonly",
        "--entrypoint",
        "tar",
        image,
        "-C",
        "/source",
        "-cpf",
        "-",
        ".",
    ]
    with destination.open("xb") as output:
        destination.chmod(0o600)
        try:
            result = subprocess.run(
                args, env=_env(), stdout=output, stderr=subprocess.PIPE, check=False
            )
        except OSError as error:
            raise BackupError("Docker volume export is unavailable") from error
    if result.returncode:
        raise BackupError("Docker volume export failed")


def _restic_env(config: BackupConfig, run_dir: Path) -> dict[str, str]:
    cache = run_dir / "restic-cache"
    cache.mkdir(mode=0o700)
    return {
        **_env(),
        "RESTIC_CACHE_DIR": str(cache),
        "RESTIC_REPOSITORY": str(config.restic_repository),
        "RESTIC_PASSWORD_FILE": str(config.restic_password_file),
    }


def _snapshot_id(data: bytes) -> str:
    snapshots: list[str] = []
    for line in data.splitlines():
        payload = _json_output(line, "Restic backup summary")
        if isinstance(payload, dict) and payload.get("message_type") == "summary":
            value = payload.get("snapshot_id")
            if isinstance(value, str) and _SNAPSHOT.fullmatch(value):
                snapshots.append(value)
    if len(snapshots) != 1:
        raise BackupError("Restic backup did not report exactly one full snapshot ID")
    return snapshots[0]


def _manifest_files(bundle: Path) -> dict[str, dict[str, object]]:
    files: dict[str, dict[str, object]] = {}
    for file in sorted(bundle.rglob("*")):
        if file.is_symlink():
            raise BackupError("backup bundle contains a symlink")
        if file.is_file() and file.name != "manifest.json":
            files[file.relative_to(bundle).as_posix()] = {
                "sha256": _sha256(file),
                "bytes": file.stat().st_size,
            }
        elif not file.is_file() and not file.is_dir():
            raise BackupError("backup bundle contains an unsupported entry")
    return files


def _atomic_json(path: Path, payload: dict[str, object]) -> None:
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(payload, output, sort_keys=True)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def run_backup(
    config_path: Path,
    *,
    command_runner: Callable[..., subprocess.CompletedProcess[bytes]] = _command,
) -> BackupResult:
    config = parse_config(config_path)
    _separate(config, config_path)
    for path in config.compose_files:
        if not path.is_file() or path.is_symlink():
            raise BackupError("selected Compose file is unavailable")
    if config.tls_directory:
        _private(config.tls_directory, "TLS directory", directory=True)
    inventory = _project_inventory(config, command_runner)
    images = _compose_images(config, command_runner)
    service_images = inventory["services"]
    if not isinstance(service_images, dict) or set(images) != set(service_images):
        raise BackupError("Compose and stopped container services differ")
    for service, details in service_images.items():
        if not isinstance(details, dict) or images[service] != details["ref"]:
            raise BackupError("stopped container image differs from pinned Compose configuration")
    # Do not allow mutable tags for the provider and DB recovery boundary.
    for service in _BASE_SERVICES - {"provider-volume-init"}:
        if "@sha256:" not in images[service]:
            raise BackupError("provider image is not digest-pinned")
    run_dir = Path(
        tempfile.mkdtemp(prefix="openslate-supabase-backup-", dir=config.staging_directory)
    )
    run_dir.chmod(0o700)
    try:
        bundle = run_dir / "bundle"
        bundle.mkdir(mode=0o700)
        (bundle / "volumes").mkdir(mode=0o700)
        for logical, name in cast(dict[str, str], inventory["volumes"]).items():
            if _project_inventory(config, command_runner) != inventory:
                raise BackupError("source project changed during volume export")
            _export_volume(name, images["db"], bundle / "volumes" / f"{logical}.tar")
        if _project_inventory(config, command_runner) != inventory:
            raise BackupError("source project changed during volume export")
        _copy_file(config.provider_env_file, bundle / "private" / "provider.env", private=True)
        if config.app_env_file:
            _copy_file(config.app_env_file, bundle / "private" / "app.env", private=True)
        if config.caddy_config_file:
            _copy_file(config.caddy_config_file, bundle / "private" / "Caddyfile", private=True)
        if config.tls_directory:
            _copy_directory(config.tls_directory, bundle / "private" / "tls", private=True)
        for source in config.compose_files:
            _copy_file(source, bundle / "compose" / source.name, private=False)
        for name in ("upstream", "templates"):
            _copy_directory(config.compose_root / name, bundle / "compose" / name, private=False)
        files = _manifest_files(bundle)
        manifest = {
            "format_version": 3,
            "source_installation_id": config.installation_id,
            "source_project": config.project_name,
            "deployment": config.deployment,
            "created_at": datetime.now(UTC).isoformat(),
            "images": service_images,
            "volumes": inventory["volumes"],
            "files": files,
        }
        manifest_path = bundle / "manifest.json"
        _atomic_json(manifest_path, manifest)
        manifest_hash = _sha256(manifest_path)
        env = _restic_env(config, run_dir)
        _run(command_runner, ["restic", "cat", "config"], "Restic repository admission", env=env)
        backup_output = _run(
            command_runner, ["restic", "backup", "--json", str(bundle)], "Restic backup", env=env
        )
        snapshot_id = _snapshot_id(backup_output)
        _run(
            command_runner, ["restic", "check", "--read-data"], "Restic data verification", env=env
        )
        verify = run_dir / "verify"
        verify.mkdir(mode=0o700)
        _run(
            command_runner,
            [
                "restic",
                "restore",
                snapshot_id,
                "--target",
                str(verify),
                "--include",
                str(manifest_path),
            ],
            "Restic manifest restore",
            env=env,
        )
        restored = verify / manifest_path.relative_to(manifest_path.anchor)
        if not restored.is_file() or _sha256(restored) != manifest_hash:
            raise BackupError("Restic manifest restore did not match the source")
        if _project_inventory(config, command_runner) != inventory:
            raise BackupError("source project changed during backup verification")
        result = BackupResult(snapshot_id, manifest_hash, datetime.now(UTC).isoformat())
    finally:
        shutil.rmtree(run_dir)
    _atomic_json(
        config.completion_marker,
        {
            "format_version": 3,
            "snapshot_id": snapshot_id,
            "manifest_sha256": manifest_hash,
            "source_installation_id": config.installation_id,
            "source_project": config.project_name,
            "completed_at": result.completed_at,
        },
    )
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = run_backup(args.config)
    except (BackupError, OSError) as error:
        detail = (
            str(error)
            if isinstance(error, BackupError)
            else "protected filesystem operation failed"
        )
        print(f"Backup failed: {detail}", file=sys.stderr)
        return 1
    print(f"Backup complete: snapshot {result.snapshot_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
