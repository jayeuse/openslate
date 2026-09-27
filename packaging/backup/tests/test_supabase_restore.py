"""Admission and no-partial-success contracts for offline Supabase restore."""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backup.backup_installation import BackupError
from backup.restore_installation import confirmation_text, run_finalize, run_restore
from test_supabase_installation import _config

SNAPSHOT = "f" * 64
TARGET_INSTANCE = "target-installation"
DB_MOUNTS = [
    {
        "Type": "volume",
        "Name": "client-b_supabase-db-data",
        "Destination": "/var/lib/postgresql/data",
    },
    {
        "Type": "volume",
        "Name": "client-b_supabase-db-config",
        "Destination": "/etc/postgresql-custom",
    },
]


def test_restore_rejects_same_project_before_touching_repository(tmp_path: Path) -> None:
    config = _config(tmp_path)
    with pytest.raises(BackupError, match="distinct"):
        run_restore(config, SNAPSHOT, "client-a", tmp_path / "target", TARGET_INSTANCE)


def test_restore_rejects_source_instance_before_mutation(tmp_path: Path) -> None:
    config = _config(tmp_path)
    calls: list[list[str]] = []

    def runner(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[bytes]:
        calls.append(args)
        return subprocess.CompletedProcess(args, 0, b"", b"")

    with pytest.raises(BackupError, match="distinct from the source installation"):
        run_restore(
            config, SNAPSHOT, "client-b", tmp_path / "target", "a" * 32, command_runner=runner
        )
    assert calls == []
    assert not (tmp_path / "target").exists()


def test_execute_requires_exact_confirmation_and_terminal(tmp_path: Path) -> None:
    config = _config(tmp_path)
    target = tmp_path / "target"
    with pytest.raises(BackupError, match="terminal"):
        run_restore(
            config,
            SNAPSHOT,
            "client-b",
            target,
            TARGET_INSTANCE,
            execute=True,
            confirmation="wrong",
            tty=False,
        )
    assert not target.exists()


def test_confirmation_binds_snapshot_project_and_target(tmp_path: Path) -> None:
    config = _config(tmp_path)
    first = confirmation_text(config, SNAPSHOT, "client-b", tmp_path / "target-a", TARGET_INSTANCE)
    assert first != confirmation_text(
        config, "e" * 64, "client-b", tmp_path / "target-a", TARGET_INSTANCE
    )
    assert first != confirmation_text(
        config, SNAPSHOT, "client-c", tmp_path / "target-a", TARGET_INSTANCE
    )
    assert first != confirmation_text(
        config, SNAPSHOT, "client-b", tmp_path / "target-b", TARGET_INSTANCE
    )
    assert first != confirmation_text(
        config, SNAPSHOT, "client-b", tmp_path / "target-a", "another-target"
    )


def test_restore_rejects_old_format_before_creating_target(tmp_path: Path) -> None:
    config = _config(tmp_path)
    data = json.loads(config.read_text(encoding="utf-8"))
    data["version"] = 2
    config.write_text(json.dumps(data), encoding="utf-8")
    target = tmp_path / "target"
    with pytest.raises(BackupError, match="version 3"):
        run_restore(config, SNAPSHOT, "client-b", target, TARGET_INSTANCE)
    assert not target.exists()


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _bundle_fixture(tmp_path: Path, config_path: Path) -> Path:
    raw_config = json.loads(config_path.read_text(encoding="utf-8"))
    bundle = tmp_path / "snapshot-source" / "openslate-supabase-backup-test" / "bundle"
    (bundle / "volumes").mkdir(parents=True)
    (bundle / "private").mkdir()
    (bundle / "compose").mkdir()

    archive_bytes = io.BytesIO()
    with tarfile.open(fileobj=archive_bytes, mode="w") as archive:
        member = tarfile.TarInfo("storage-object")
        member.size = len(b"private storage bytes")
        archive.addfile(member, io.BytesIO(b"private storage bytes"))
    for logical in _volume_names(config_path):
        (bundle / "volumes" / f"{logical}.tar").write_bytes(archive_bytes.getvalue())
    (bundle / "private" / "provider.env").write_bytes(
        Path(raw_config["provider_env_file"]).read_bytes()
    )

    compose_root = Path(raw_config["compose_root"])
    overlay = "compose.dev.yaml"
    for source in (compose_root / "compose.yaml", compose_root / overlay):
        destination = bundle / "compose" / source.name
        destination.write_bytes(source.read_bytes())
    for name in ("upstream", "templates"):
        source_root = compose_root / name
        for source in source_root.rglob("*"):
            relative = source.relative_to(source_root)
            destination = bundle / "compose" / name / relative
            if source.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            elif source.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(source.read_bytes())

    files = {
        source.relative_to(bundle).as_posix(): {
            "sha256": _digest(source),
            "bytes": source.stat().st_size,
        }
        for source in bundle.rglob("*")
        if source.is_file()
    }
    volumes = {name: f"client-a_{name}" for name in _volume_names(config_path)}
    manifest = {
        "format_version": 3,
        "source_installation_id": "a" * 32,
        "source_project": "client-a",
        "deployment": "development",
        "created_at": "2026-09-27T00:00:00+00:00",
        "images": {
            "db": {
                "ref": "supabase/postgres@sha256:" + "a" * 64,
                "id": "sha256:" + "b" * 64,
            }
        },
        "volumes": volumes,
        "files": files,
    }
    (bundle / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return bundle


def _volume_names(config_path: Path) -> tuple[str, ...]:
    from backup.backup_installation import parse_config

    return parse_config(config_path).volume_names


class RestoreCommands:
    def __init__(self, bundle: Path, *, collision: str | None = None) -> None:
        self.bundle = bundle
        self.collision = collision
        self.calls: list[list[str]] = []

    def __call__(
        self, args: list[str], *, env: dict[str, str]
    ) -> subprocess.CompletedProcess[bytes]:
        self.calls.append(args)
        if args[:3] == ["docker", "volume", "create"]:
            return subprocess.CompletedProcess(args, 0, args[-1].encode(), b"")
        if args[:3] == ["docker", "ps", "-aq"]:
            output = b"existing-container\n" if self.collision == "container" else b""
            return subprocess.CompletedProcess(args, 0, output, b"")
        if args[:4] == ["docker", "volume", "ls", "-q"]:
            output = b"client-b_supabase-db-data\n" if self.collision == "volume" else b""
            return subprocess.CompletedProcess(args, 0, output, b"")
        if args[:4] == ["docker", "network", "ls", "-q"]:
            output = b"client-b_provider\n" if self.collision == "network" else b""
            return subprocess.CompletedProcess(args, 0, output, b"")
        if args[:3] == ["docker", "container", "inspect"]:
            item = {
                "Id": "existing-container",
                "Config": {
                    "Image": "supabase/postgres@sha256:" + "a" * 64,
                    "Labels": {
                        "com.docker.compose.project": "client-b",
                        "com.docker.compose.service": "db",
                    },
                },
                "Image": "sha256:" + "b" * 64,
                "State": {"Status": "exited"},
            }
            return subprocess.CompletedProcess(args, 0, json.dumps([item]).encode(), b"")
        if args[:3] == ["docker", "volume", "inspect"]:
            item = {
                "Name": "client-b_supabase-db-data",
                "Labels": {
                    "com.docker.compose.project": "client-b",
                    "com.docker.compose.volume": "supabase-db-data",
                },
            }
            return subprocess.CompletedProcess(args, 0, json.dumps([item]).encode(), b"")
        if args[:3] == ["docker", "network", "inspect"]:
            item = {
                "Name": "client-b_provider",
                "Labels": {
                    "com.docker.compose.project": "client-b",
                    "com.docker.compose.network": "provider",
                },
            }
            return subprocess.CompletedProcess(args, 0, json.dumps([item]).encode(), b"")
        if args[:2] == ["docker", "ps"]:
            output = b"client-b-stray\n" if self.collision == "orphan-container" else b""
            return subprocess.CompletedProcess(args, 0, output, b"")
        if args[:2] == ["docker", "volume"]:
            output = b"client-b_stray\n" if self.collision == "orphan-volume" else b""
            return subprocess.CompletedProcess(args, 0, output, b"")
        if args[:2] == ["docker", "network"]:
            output = b"client-b_stray\n" if self.collision == "orphan-network" else b""
            return subprocess.CompletedProcess(args, 0, output, b"")
        if args[:3] == ["restic", "ls", "--json"]:
            nodes = []
            for path in self.bundle.rglob("*"):
                kind = "dir" if path.is_dir() else "file"
                nodes.append({"struct_type": "node", "type": kind, "path": path.as_posix()})
            return subprocess.CompletedProcess(
                args,
                0,
                "\n".join(json.dumps(item) for item in nodes).encode(),
                b"",
            )
        if args[:2] == ["restic", "restore"]:
            target = Path(args[args.index("--target") + 1])
            destination_root = target / self.bundle.relative_to(self.bundle.anchor)
            for source in self.bundle.rglob("*"):
                destination = destination_root / source.relative_to(self.bundle)
                if source.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                else:
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(source.read_bytes())
            return subprocess.CompletedProcess(args, 0, b"", b"")
        if args[:3] == ["docker", "image", "inspect"]:
            return subprocess.CompletedProcess(
                args, 0, json.dumps([{"Id": "sha256:" + "b" * 64}]).encode(), b""
            )
        return subprocess.CompletedProcess(args, 0, b"", b"")


def test_restore_cleanup_failure_does_not_publish_a_pending_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _config(tmp_path)
    bundle = _bundle_fixture(tmp_path, config)
    target = tmp_path / "restored-target"
    commands = RestoreCommands(bundle)
    from backup import restore_installation

    monkeypatch.setattr(restore_installation, "_import_volume", lambda *_: None)

    original_rmtree = shutil.rmtree

    def fail_operation_cleanup(path: str | Path, *args: Any, **kwargs: Any) -> None:
        if Path(path).name.startswith("openslate-supabase-restore-") and target.exists():
            raise OSError("restore staging cleanup failed")
        original_rmtree(path, *args, **kwargs)

    monkeypatch.setattr(restore_installation.shutil, "rmtree", fail_operation_cleanup)
    confirmation = confirmation_text(config, SNAPSHOT, "client-b", target, TARGET_INSTANCE)

    with pytest.raises((BackupError, OSError), match="cleanup"):
        run_restore(
            config,
            SNAPSHOT,
            "client-b",
            target,
            TARGET_INSTANCE,
            execute=True,
            confirmation=confirmation,
            tty=True,
            command_runner=commands,
        )

    assert target.exists()
    assert any(args[:3] == ["docker", "volume", "create"] for args in commands.calls)
    assert not (target / "restore-pending.json").exists()


def _execute(
    config: Path,
    commands: RestoreCommands,
    target: Path,
    *,
    snapshot: str = SNAPSHOT,
    project: str = "client-b",
    target_instance: str = TARGET_INSTANCE,
) -> object:
    confirmation = confirmation_text(config, snapshot, project, target, target_instance)
    return run_restore(
        config,
        snapshot,
        project,
        target,
        target_instance,
        execute=True,
        confirmation=confirmation,
        tty=True,
        command_runner=commands,
    )


def test_restore_inspection_verifies_archive_without_creating_target_or_volumes(
    tmp_path: Path,
) -> None:
    config = _config(tmp_path)
    bundle = _bundle_fixture(tmp_path, config)
    target = tmp_path / "inspection-target"
    commands = RestoreCommands(bundle)

    result = run_restore(
        config, SNAPSHOT, "client-b", target, TARGET_INSTANCE, command_runner=commands
    )

    assert result.executed is False
    assert result.source_installation_id == "a" * 32
    assert result.target_instance_id == TARGET_INSTANCE
    assert not target.exists()
    assert not any(args[:3] == ["docker", "volume", "create"] for args in commands.calls)
    assert not list((tmp_path / "staging").iterdir())


def test_restore_requires_a_full_snapshot_id_before_external_commands(tmp_path: Path) -> None:
    config = _config(tmp_path)
    bundle = _bundle_fixture(tmp_path, config)
    target = tmp_path / "short-id-target"
    commands = RestoreCommands(bundle)

    with pytest.raises(BackupError, match="full 64-character"):
        run_restore(
            config, SNAPSHOT[:12], "client-b", target, TARGET_INSTANCE, command_runner=commands
        )

    assert commands.calls == []
    assert not target.exists()


@pytest.mark.parametrize(
    "collision",
    [
        "container",
        "volume",
        "network",
        "orphan-container",
        "orphan-volume",
        "orphan-network",
    ],
)
def test_restore_rejects_target_project_resource_collisions_before_writes(
    tmp_path: Path, collision: str
) -> None:
    config = _config(tmp_path)
    bundle = _bundle_fixture(tmp_path, config)
    target = tmp_path / "collision-target"
    commands = RestoreCommands(bundle, collision=collision)

    with pytest.raises(BackupError):
        _execute(config, commands, target)

    assert not any(args[0] == "restic" for args in commands.calls)
    assert not any(args[:3] == ["docker", "volume", "create"] for args in commands.calls)
    assert not target.exists()


def test_restore_rejects_an_existing_target_directory_before_commands(tmp_path: Path) -> None:
    config = _config(tmp_path)
    bundle = _bundle_fixture(tmp_path, config)
    target = tmp_path / "existing-target"
    target.mkdir(mode=0o700)
    commands = RestoreCommands(bundle)

    with pytest.raises(BackupError, match="fresh absolute path"):
        run_restore(config, SNAPSHOT, "client-b", target, TARGET_INSTANCE, command_runner=commands)

    assert commands.calls == []
    assert list(target.iterdir()) == []


@pytest.mark.parametrize(
    ("snapshot", "expected_project", "expected_target", "expected_instance"),
    [
        ("e" * 64, "client-b", "target", TARGET_INSTANCE),
        (SNAPSHOT, "client-c", "target", TARGET_INSTANCE),
        (SNAPSHOT, "client-b", "other-target", TARGET_INSTANCE),
        (SNAPSHOT, "client-b", "target", "another-target"),
    ],
)
def test_restore_confirmation_is_bound_to_snapshot_and_all_target_identity(
    tmp_path: Path,
    snapshot: str,
    expected_project: str,
    expected_target: str,
    expected_instance: str,
) -> None:
    config = _config(tmp_path)
    bundle = _bundle_fixture(tmp_path, config)
    target = tmp_path / "target"
    confirmation = confirmation_text(config, SNAPSHOT, "client-b", target, TARGET_INSTANCE)
    commands = RestoreCommands(bundle)
    with pytest.raises(BackupError, match="exact snapshot and target confirmation"):
        run_restore(
            config,
            snapshot,
            expected_project,
            tmp_path / expected_target,
            expected_instance,
            execute=True,
            confirmation=confirmation,
            tty=True,
            command_runner=commands,
        )

    assert commands.calls == []


@pytest.mark.parametrize(
    "corruption",
    ["manifest", "file", "wrong-source-project", "wrong-source-installation", "unsafe-tar"],
)
def test_restore_rejects_corrupt_or_wrong_source_archive_before_target_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, corruption: str
) -> None:
    config = _config(tmp_path)
    bundle = _bundle_fixture(tmp_path, config)
    target = tmp_path / "rejected-target"
    manifest_path = bundle / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    volume_path = bundle / "volumes" / "supabase-db-data.tar"
    if corruption == "manifest":
        manifest["format_version"] = 2
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    elif corruption == "file":
        volume_path.write_bytes(volume_path.read_bytes() + b"altered")
    elif corruption == "wrong-source-project":
        manifest["source_project"] = "client-z"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    elif corruption == "wrong-source-installation":
        manifest["source_installation_id"] = "c" * 32
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    else:
        archive_bytes = io.BytesIO()
        with tarfile.open(fileobj=archive_bytes, mode="w") as archive:
            member = tarfile.TarInfo("../escape.txt")
            member.size = len(b"escape")
            archive.addfile(member, io.BytesIO(b"escape"))
        volume_path.write_bytes(archive_bytes.getvalue())
        relative = volume_path.relative_to(bundle).as_posix()
        manifest["files"][relative] = {
            "sha256": _digest(volume_path),
            "bytes": volume_path.stat().st_size,
        }
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    commands = RestoreCommands(bundle)
    imported: list[str] = []
    from backup import restore_installation

    monkeypatch.setattr(
        restore_installation, "_import_volume", lambda *args: imported.append(args[0])
    )

    with pytest.raises(BackupError):
        _execute(config, commands, target)

    assert imported == []
    assert not any(args[:3] == ["docker", "volume", "create"] for args in commands.calls)
    assert not target.exists()
    assert not list((tmp_path / "staging").iterdir())


def test_restore_failed_volume_import_does_not_publish_pending_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _config(tmp_path)
    bundle = _bundle_fixture(tmp_path, config)
    target = tmp_path / "failed-import-target"
    commands = RestoreCommands(bundle)
    from backup import restore_installation

    def fail_import(*_: object) -> None:
        raise BackupError("volume import failed")

    monkeypatch.setattr(restore_installation, "_import_volume", fail_import)

    with pytest.raises(BackupError, match="volume import failed"):
        _execute(config, commands, target)

    assert not target.exists()
    assert not list((tmp_path / "staging").iterdir())


def test_restore_stages_verified_bundle_only_after_every_volume_import(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = _config(tmp_path)
    bundle = _bundle_fixture(tmp_path, config)
    raw = json.loads(config.read_text(encoding="utf-8"))
    target = tmp_path / "successful-target"
    commands = RestoreCommands(bundle)
    imports: list[tuple[str, str, bytes]] = []
    from backup import restore_installation

    def record_import(volume: str, image: str, archive: Path) -> None:
        imports.append((volume, image, archive.read_bytes()))

    monkeypatch.setattr(restore_installation, "_import_volume", record_import)

    result = _execute(config, commands, target)

    marker = json.loads((target / "restore-pending.json").read_text(encoding="utf-8"))
    assert result.executed is True
    assert marker["target_project"] == "client-b"
    assert marker["target_instance_id"] == TARGET_INSTANCE
    assert len(imports) == len(_volume_names(config))
    assert all(image == "supabase/postgres@sha256:" + "a" * 64 for _, image, _ in imports)
    assert all(contents for _, _, contents in imports)
    assert (target / "restored-source-private" / "provider.env").read_bytes() == Path(
        raw["provider_env_file"]
    ).read_bytes()
    assert (target / "compose" / "compose.yaml").is_file()
    assert not list(Path(raw["staging_directory"]).iterdir())


class FinalizeCommands:
    def __init__(
        self,
        *,
        cluster_name: str = TARGET_INSTANCE,
        postcondition: bytes = b"t\n",
        mounts: list[dict[str, str]] | None = None,
    ) -> None:
        self.cluster_name = cluster_name
        self.postcondition = postcondition
        self.mounts = DB_MOUNTS if mounts is None else mounts
        self.calls: list[list[str]] = []

    def __call__(
        self, args: list[str], *, env: dict[str, str]
    ) -> subprocess.CompletedProcess[bytes]:
        self.calls.append(args)
        output = b""
        if args[:3] == ["docker", "ps", "-aq"]:
            output = b"db-container\n"
        elif args[:3] == ["docker", "container", "inspect"]:
            output = json.dumps(
                [
                    {
                        "Id": "db-container",
                        "State": {"Status": "running"},
                        "Config": {
                            "Image": "supabase/postgres@sha256:pinned",
                            "Labels": {
                                "com.docker.compose.project": "client-b",
                                "com.docker.compose.service": "db",
                            },
                        },
                        "HostConfig": {"PortBindings": {}},
                        "NetworkSettings": {"Networks": {"client-b_provider": {}}},
                        "Mounts": self.mounts,
                    }
                ]
            ).encode()
        elif args[:3] == ["docker", "network", "inspect"]:
            output = b'[{"Internal": true}]'
        elif args[:4] == ["docker", "volume", "ls", "-q"]:
            output = (
                b"\n".join(
                    f"client-b_{name}".encode()
                    for name in (
                        "supabase-db-data",
                        "supabase-db-config",
                        "supabase-storage-data",
                        "supabase-studio-snippets",
                    )
                )
                + b"\n"
            )
        elif args[:3] == ["docker", "volume", "inspect"]:
            output = json.dumps(
                [
                    {
                        "Name": volume,
                        "Labels": {
                            "com.docker.compose.project": "client-b",
                            "com.docker.compose.volume": volume.removeprefix("client-b_"),
                        },
                    }
                    for volume in args[3:]
                ]
            ).encode()
        elif args[:2] == ["docker", "exec"]:
            if "current_setting('cluster_name', true)" in args[-1]:
                output = (
                    json.dumps(
                        {
                            "database": "postgres",
                            "user": "supabase_admin",
                            "cluster_name": self.cluster_name,
                        }
                    ).encode()
                    + b"\n"
                )
            elif "NOT EXISTS" in args[-1]:
                output = self.postcondition
        return subprocess.CompletedProcess(args, 0, output, b"")


def _pending_restore(tmp_path: Path) -> tuple[Path, Path]:
    config = _config(tmp_path)
    target = tmp_path / "target"
    target.mkdir(mode=0o700)
    compose = target / "compose"
    compose.mkdir(mode=0o700)
    (compose / "compose.yaml").write_text("image: supabase/postgres@sha256:pinned\n")
    (target / "restore-pending.json").write_text(
        json.dumps(
            {
                "format_version": 3,
                "snapshot_id": SNAPSHOT,
                "source_installation_id": "a" * 32,
                "target_project": "client-b",
                "target_instance_id": TARGET_INSTANCE,
                "volume_names": [
                    f"client-b_{name}"
                    for name in (
                        "supabase-db-data",
                        "supabase-db-config",
                        "supabase-storage-data",
                        "supabase-studio-snippets",
                    )
                ],
            }
        )
    )
    (target / "restore-pending.json").chmod(0o600)
    return config, target


def test_finalize_rejects_wrong_live_cluster_before_sql_write(tmp_path: Path) -> None:
    config, target = _pending_restore(tmp_path)
    commands = FinalizeCommands(cluster_name="a" * 32)
    with pytest.raises(BackupError, match="cluster identity"):
        run_finalize(config, SNAPSHOT, "client-b", target, TARGET_INSTANCE, command_runner=commands)
    assert not any("UPDATE public.identity_sessions" in args[-1] for args in commands.calls)
    assert not (target / "restore-finalized.json").exists()


@pytest.mark.parametrize(
    "mounts",
    [
        DB_MOUNTS[:1],
        [{**DB_MOUNTS[0], "Name": "client-a_supabase-db-data"}, DB_MOUNTS[1]],
        [{**DB_MOUNTS[0], "Type": "bind"}, DB_MOUNTS[1]],
        [*DB_MOUNTS, DB_MOUNTS[0]],
        [*DB_MOUNTS, {"Type": "bind", "Destination": "/var/lib/postgresql/data/base"}],
    ],
    ids=["missing-config", "source-data", "bind-data", "ambiguous-data", "nested-data"],
)
def test_finalize_rejects_unowned_database_mounts_before_sql(
    tmp_path: Path, mounts: list[dict[str, str]]
) -> None:
    config, target = _pending_restore(tmp_path)
    commands = FinalizeCommands(mounts=mounts)
    with pytest.raises(BackupError, match="mount"):
        run_finalize(config, SNAPSHOT, "client-b", target, TARGET_INSTANCE, command_runner=commands)
    assert not any(args[:2] == ["docker", "exec"] for args in commands.calls)
    assert not (target / "restore-finalized.json").exists()


def test_finalize_requires_verified_session_postcondition(tmp_path: Path) -> None:
    config, target = _pending_restore(tmp_path)
    commands = FinalizeCommands(postcondition=b"f\n")
    with pytest.raises(BackupError, match="postcondition"):
        run_finalize(config, SNAPSHOT, "client-b", target, TARGET_INSTANCE, command_runner=commands)
    assert any("UPDATE public.identity_sessions" in args[-1] for args in commands.calls)
    assert not (target / "restore-finalized.json").exists()


def test_finalize_verified_target_writes_identity_marker(tmp_path: Path) -> None:
    config, target = _pending_restore(tmp_path)
    commands = FinalizeCommands()
    run_finalize(config, SNAPSHOT, "client-b", target, TARGET_INSTANCE, command_runner=commands)
    marker = json.loads((target / "restore-finalized.json").read_text())
    assert marker["target_instance_id"] == TARGET_INSTANCE
    assert marker["application_sessions_invalidated"] is True
    assert all(
        "-U" in args and args[args.index("-U") + 1] == "supabase_admin"
        for args in commands.calls
        if args[:2] == ["docker", "exec"]
    )
