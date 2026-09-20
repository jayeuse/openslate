"""Failure-boundary coverage for private local storage."""

from __future__ import annotations

import os
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException

import app.systems.platform.files.storage as storage_module
import app.systems.platform.files.windows_storage as windows_module
from app.systems.platform.files.providers import ProviderRejected, ProviderUnavailable, StorageStat
from app.systems.platform.files.storage import LocalFilesystemStorage


class _WindowsBackend:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.quarantine_root = root / "quarantine"
        self.objects_root = root / "objects"
        self.calls: list[tuple[object, ...]] = []

    def upload(self, key: str, content: bytes, media_type: str) -> None:
        self.calls.append(("upload", key, content, media_type))

    def read_quarantine(self, key: str) -> bytes:
        self.calls.append(("read_quarantine", key))
        return b"quarantine"

    def promote(self, key: str, *, expected_digest: str, expected_size: int) -> None:
        self.calls.append(("promote", key, expected_digest, expected_size))

    def download(self, key: str) -> bytes:
        self.calls.append(("download", key))
        return b"ready"

    def stat(self, key: str, *, quarantine: bool) -> StorageStat:
        self.calls.append(("stat", key, quarantine))
        return StorageStat(5, "a" * 64)

    def delete(self, key: str) -> None:
        self.calls.append(("delete", key))


def test_windows_dispatch_uses_only_the_handle_based_backend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "private"
    backend = _WindowsBackend(root)
    filesystem = object()
    monkeypatch.setattr(storage_module.os, "name", "nt")
    monkeypatch.setattr(windows_module, "CreateFileWindowsFilesystem", lambda _: filesystem)
    monkeypatch.setattr(
        windows_module,
        "WindowsLocalFilesystemStorage",
        lambda selected_root, selected_filesystem: backend
        if (selected_root, selected_filesystem) == (root, filesystem)
        else None,
    )

    storage = LocalFilesystemStorage(root)
    storage.upload("a" * 32, b"bytes", "text/plain")
    assert storage.read_quarantine("a" * 32) == b"quarantine"
    storage.promote("a" * 32, expected_digest="b" * 64, expected_size=5)
    assert storage.download("a" * 32) == b"ready"
    assert storage.stat("a" * 32, quarantine=False) == StorageStat(5, "a" * 64)
    storage.delete("a" * 32)

    assert storage.root == root
    assert backend.calls == [
        ("upload", "a" * 32, b"bytes", "text/plain"),
        ("read_quarantine", "a" * 32),
        ("promote", "a" * 32, "b" * 64, 5),
        ("download", "a" * 32),
        ("stat", "a" * 32, False),
        ("delete", "a" * 32),
    ]


def test_posix_storage_refuses_missing_nofollow_and_root_setup_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(storage_module, "_NOFOLLOW", None)
    with pytest.raises(ProviderUnavailable, match="no-follow"):
        LocalFilesystemStorage(tmp_path / "missing-nofollow")

    monkeypatch.setattr(storage_module, "_NOFOLLOW", os.O_NOFOLLOW)
    monkeypatch.setattr(
        LocalFilesystemStorage,
        "_ensure_private_directory",
        lambda *_: (_ for _ in ()).throw(OSError("read only")),
    )
    with pytest.raises(ProviderUnavailable, match="Private storage is unavailable"):
        LocalFilesystemStorage(tmp_path / "unwritable")


def test_reopening_storage_repairs_existing_directory_modes(tmp_path: Path) -> None:
    root = tmp_path / "private"
    LocalFilesystemStorage(root)
    root.chmod(0o755)

    LocalFilesystemStorage(root)

    assert root.stat().st_mode & 0o777 == 0o700


def test_promotion_reports_missing_source_invalid_expectation_and_disappearing_destination(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = LocalFilesystemStorage(tmp_path / "private")
    key = "c" * 32
    with pytest.raises(ProviderRejected, match="unavailable"):
        storage.promote(key, expected_digest="a" * 64, expected_size=1)
    with pytest.raises(ProviderRejected, match="expectation"):
        storage.promote(key, expected_digest="invalid", expected_size=0)

    content = b"content"
    storage.upload(key, content, "application/octet-stream")
    original = storage._regular_stat
    calls = 0

    def disappearing(directory: int, selected: str, *, allow_oversized: bool = False):
        nonlocal calls
        calls += 1
        if calls == 3:
            return None
        return original(directory, selected, allow_oversized=allow_oversized)

    monkeypatch.setattr(storage, "_regular_stat", disappearing)
    with pytest.raises(ProviderUnavailable, match="promotion"):
        storage.promote(
            key,
            expected_digest=sha256(content).hexdigest(),
            expected_size=len(content),
        )


def test_posix_helpers_reject_non_directories_changed_reads_and_replaced_deletes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = LocalFilesystemStorage(tmp_path / "private")
    ordinary = tmp_path / "ordinary"
    ordinary.write_bytes(b"content")
    descriptor = os.open(ordinary, os.O_RDONLY)
    try:
        with pytest.raises(OSError, match="not a directory"):
            storage._require_directory(descriptor)
    finally:
        os.close(descriptor)

    key = "d" * 32
    storage.upload(key, b"content", "application/octet-stream")
    with storage._shard(key, quarantine=True) as shard:
        metadata = storage._regular_stat(shard, key)
        assert metadata is not None
        original_fstat = storage_module.os.fstat
        monkeypatch.setattr(
            storage_module.os,
            "fstat",
            lambda fd: SimpleNamespace(
                st_mode=original_fstat(fd).st_mode,
                st_dev=original_fstat(fd).st_dev,
                st_ino=original_fstat(fd).st_ino,
                st_size=original_fstat(fd).st_size + 1,
            ),
        )
        with pytest.raises(OSError, match="changed during read"):
            storage._read_exact(shard, key, metadata)
        monkeypatch.undo()

    with storage._shard(key, quarantine=True) as shard:
        metadata = storage._regular_stat(shard, key)
        assert metadata is not None
        replaced = SimpleNamespace(st_dev=metadata.st_dev, st_ino=metadata.st_ino + 1)
        monkeypatch.setattr(LocalFilesystemStorage, "_regular_stat", Mock(return_value=replaced))
        with pytest.raises(OSError, match="changed before deletion"):
            storage._unlink_if_same(shard, key, metadata)


def test_stat_delete_and_dependency_translate_provider_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = LocalFilesystemStorage(tmp_path / "private")
    key = "e" * 32
    assert storage.stat(key, quarantine=True) is None

    monkeypatch.setattr(storage, "_regular_stat", Mock(side_effect=OSError("unsafe")))
    with pytest.raises(ProviderUnavailable, match="read"):
        storage.stat(key, quarantine=True)
    with pytest.raises(ProviderUnavailable, match="deletion"):
        storage.delete(key)

    monkeypatch.setattr(
        storage_module,
        "LocalFilesystemStorage",
        Mock(side_effect=ProviderUnavailable("offline")),
    )
    monkeypatch.setattr(
        storage_module,
        "get_settings",
        lambda: SimpleNamespace(files_storage_root=tmp_path / "configured"),
    )
    with pytest.raises(HTTPException) as caught:
        storage_module.get_storage()
    assert caught.value.status_code == 503
    assert caught.value.detail["code"] == "storage_unavailable"
