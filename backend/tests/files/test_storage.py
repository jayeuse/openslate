"""Private filesystem storage contracts at the provider boundary."""

import os
from hashlib import sha256
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import CheckConstraint, SmallInteger

from app.systems.platform.files.models import File
from app.systems.platform.files.providers import (
    ProviderRejected,
    ProviderUnavailable,
    ProviderWriteRejected,
)
from app.systems.platform.files.storage import LocalFilesystemStorage
from app.systems.platform.files.windows_storage import (
    CreateFileWindowsFilesystem,
    WindowsLocalFilesystemStorage,
)


def _storage(tmp_path: Path) -> LocalFilesystemStorage:
    return LocalFilesystemStorage(tmp_path / "private-files")


class _WindowsFilesystem:
    def __init__(self) -> None:
        self.files: dict[Path, bytes] = {}

    def write_new(self, path: Path, content: bytes) -> None:
        if path in self.files:
            raise ProviderRejected("exists")
        self.files[path] = content

    def read(self, path: Path, *, allow_oversized: bool = False) -> bytes | None:
        return self.files.get(path)

    def delete(self, path: Path) -> None:
        self.files.pop(path, None)


def test_quarantine_upload_then_clean_promotion_exposes_exact_ready_bytes(tmp_path: Path) -> None:
    storage = _storage(tmp_path)
    key = "a" * 32
    content = b"clean bytes"

    storage.upload(key, content, "application/octet-stream")

    assert storage.download(key) is None
    assert storage.read_quarantine(key) == content
    assert storage.stat(key, quarantine=True).digest == sha256(content).hexdigest()
    storage.promote(key, expected_digest=sha256(content).hexdigest(), expected_size=len(content))
    assert storage.read_quarantine(key) == content
    assert storage.download(key) == content
    assert storage.stat(key, quarantine=False).size == len(content)


def test_storage_rejects_traversal_and_symlink_escape(tmp_path: Path) -> None:
    storage = _storage(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    prefix = storage.quarantine_root / "b0"
    prefix.symlink_to(outside, target_is_directory=True)

    with pytest.raises(ProviderRejected):
        storage.upload("../" + "a" * 32, b"bytes", "application/octet-stream")
    with pytest.raises(ProviderUnavailable):
        storage.upload("b" + "0" * 31, b"bytes", "application/octet-stream")
    assert not any(outside.iterdir())


def test_upload_never_overwrites_an_immutable_quarantine_object(tmp_path: Path) -> None:
    storage = _storage(tmp_path)
    key = "c" * 32
    storage.upload(key, b"first", "application/octet-stream")

    with pytest.raises(ProviderRejected):
        storage.upload(key, b"second", "application/octet-stream")
    assert storage.read_quarantine(key) == b"first"


def test_storage_rejects_bytes_above_the_private_object_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = _storage(tmp_path)
    monkeypatch.setattr("app.systems.platform.files.storage.MAX_BYTES", 4)

    with pytest.raises(ProviderRejected):
        storage.upload("c" * 32, b"five!", "application/octet-stream")


def test_delete_is_idempotent_across_quarantine_and_ready_locations(tmp_path: Path) -> None:
    storage = _storage(tmp_path)
    key = "d" * 32
    storage.upload(key, b"bytes", "application/octet-stream")
    storage.delete(key)
    storage.delete(key)

    assert storage.read_quarantine(key) is None
    assert storage.download(key) is None


def test_pre_install_write_failure_is_definitive_and_leaves_no_partial_object(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = _storage(tmp_path)
    key = "e" * 32

    def fail_fsync(_: int) -> None:
        raise OSError("disk full")

    monkeypatch.setattr("app.systems.platform.files.storage.os.fsync", fail_fsync)
    with pytest.raises(ProviderWriteRejected):
        storage.upload(key, b"bytes", "application/octet-stream")
    assert storage.read_quarantine(key) is None


def test_post_install_write_failure_remains_unresolved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = _storage(tmp_path)
    key = "0" * 32
    original_fsync = os.fsync
    calls = 0

    def fail_after_install(descriptor: int) -> None:
        nonlocal calls
        calls += 1
        if calls == 3:
            raise OSError("metadata sync failed after install")
        original_fsync(descriptor)

    monkeypatch.setattr("app.systems.platform.files.storage.os.fsync", fail_after_install)
    with pytest.raises(ProviderUnavailable) as caught:
        storage.upload(key, b"bytes", "application/octet-stream")
    assert type(caught.value) is ProviderUnavailable
    assert storage.read_quarantine(key) == b"bytes"


def test_ready_read_permission_failure_is_translated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = _storage(tmp_path)
    key = "1" * 32
    storage.upload(key, b"bytes", "application/octet-stream")
    storage.promote(key, expected_digest=sha256(b"bytes").hexdigest(), expected_size=5)

    original_open = os.open

    def deny(path: object, flags: int, *args: object, **kwargs: object) -> int:
        if path == key:
            raise PermissionError("denied")
        return original_open(path, flags, *args, **kwargs)

    monkeypatch.setattr("app.systems.platform.files.storage.os.open", deny)
    with pytest.raises(ProviderUnavailable):
        storage.download(key)


@pytest.mark.skipif(os.name == "nt", reason="Windows ACL verification belongs to the installer")
def test_private_storage_uses_owner_only_permissions(tmp_path: Path) -> None:
    storage = _storage(tmp_path)
    key = "2" * 32
    storage.upload(key, b"bytes", "application/octet-stream")

    object_path = storage.quarantine_root / key[:2] / key
    assert storage.root.stat().st_mode & 0o777 == 0o700
    assert object_path.stat().st_mode & 0o777 == 0o600


def test_promotion_retains_exact_quarantine_bytes_until_metadata_is_durable(tmp_path: Path) -> None:
    storage = _storage(tmp_path)
    key = "f" * 32
    content = b"bytes"
    storage.upload(key, content, "application/octet-stream")
    digest = sha256(content).hexdigest()

    storage.promote(key, expected_digest=digest, expected_size=len(content))
    assert storage.download(key) == content
    assert storage.read_quarantine(key) == content
    storage.promote(key, expected_digest=digest, expected_size=len(content))
    assert storage.read_quarantine(key) == content
    assert storage.download(key) == content


def test_promotion_rejects_post_scan_integrity_mismatch(tmp_path: Path) -> None:
    storage = _storage(tmp_path)
    key = "3" * 32
    storage.upload(key, b"changed", "application/octet-stream")

    with pytest.raises(ProviderRejected):
        storage.promote(key, expected_digest=sha256(b"clean").hexdigest(), expected_size=5)
    assert storage.download(key) is None


def test_delete_removes_an_oversized_corrupt_private_object(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = _storage(tmp_path)
    key = "4" * 32
    storage.upload(key, b"bytes", "application/octet-stream")
    monkeypatch.setattr("app.systems.platform.files.storage.MAX_BYTES", 4)

    with pytest.raises(ProviderUnavailable):
        storage.read_quarantine(key)
    storage.delete(key)
    object_path = storage.quarantine_root / key[:2] / key
    assert not object_path.exists()


def test_leaf_symlink_is_rejected_without_reading_its_target(tmp_path: Path) -> None:
    storage = _storage(tmp_path)
    key = "5" * 32
    outside = tmp_path / "outside-bytes"
    outside.write_bytes(b"outside")
    target = storage.quarantine_root / key[:2]
    target.mkdir()
    (target / key).symlink_to(outside)

    with pytest.raises(ProviderUnavailable):
        storage.read_quarantine(key)


def test_new_shard_fsyncs_its_parent_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = _storage(tmp_path)
    key = "6" * 32
    fsynced_inodes: set[tuple[int, int]] = set()
    original_fsync = os.fsync

    def track(descriptor: int) -> None:
        metadata = os.fstat(descriptor)
        fsynced_inodes.add((metadata.st_dev, metadata.st_ino))
        original_fsync(descriptor)

    monkeypatch.setattr("app.systems.platform.files.storage.os.fsync", track)
    storage.upload(key, b"bytes", "application/octet-stream")
    metadata = storage.quarantine_root.stat()
    assert (metadata.st_dev, metadata.st_ino) in fsynced_inodes


def test_windows_adapter_keeps_quarantine_when_copying_verified_ready_bytes(tmp_path: Path) -> None:
    filesystem = _WindowsFilesystem()
    storage = WindowsLocalFilesystemStorage(tmp_path / "private-files", filesystem)
    key = "7" * 32
    content = b"bytes"
    digest = sha256(content).hexdigest()
    storage.upload(key, content, "application/octet-stream")
    storage.promote(key, expected_digest=digest, expected_size=len(content))

    assert storage.read_quarantine(key) == content
    assert storage.download(key) == content


@pytest.mark.parametrize("partial,flush", [(True, True), (False, False)])
def test_windows_handle_writer_rejects_partial_writes_and_flush_failures(
    partial: bool, flush: bool
) -> None:
    adapter = object.__new__(CreateFileWindowsFilesystem)

    class Kernel:
        def WriteFile(self, handle, buffer, size, written, unused):
            written.value = size - 1 if partial else size
            return True

        def FlushFileBuffers(self, handle):
            return flush

    adapter.kernel32 = Kernel()
    adapter.ctypes = SimpleNamespace(
        create_string_buffer=lambda value: value,
        byref=lambda value: value,
    )
    adapter.wintypes = SimpleNamespace(DWORD=lambda: SimpleNamespace(value=0))

    with pytest.raises(ProviderUnavailable):
        adapter._write_chunks(1, b"bytes")


@pytest.mark.parametrize("failure", ["location_containment", "parent_open"])
def test_windows_write_closes_location_handle_on_directory_setup_failure(
    tmp_path: Path, failure: str
) -> None:
    adapter = object.__new__(CreateFileWindowsFilesystem)
    location = tmp_path / "objects"
    location.mkdir()
    path = location / "aa" / ("a" * 32)
    closed: list[int] = []
    shares: list[int] = []

    class Kernel:
        def CloseHandle(self, handle: int) -> None:
            closed.append(handle)

    def open_handle(
        opened_path: Path,
        access: int,
        disposition: int,
        *,
        directory: bool = False,
        share: int = 0,
    ) -> int:
        del access, disposition, directory
        shares.append(share)
        if opened_path == location:
            return 11
        raise ProviderUnavailable("parent unavailable")

    adapter.kernel32 = Kernel()
    adapter._open = open_handle
    adapter._require_contained = (
        (lambda _handle: (_ for _ in ()).throw(ProviderUnavailable("escaped")))
        if failure == "location_containment"
        else lambda _handle: None
    )

    with pytest.raises(ProviderUnavailable):
        adapter.write_new(path, b"bytes")

    assert closed == [11]
    assert shares[0] == 0x00000003


def test_windows_temporary_write_failure_closes_and_removes_partial_file(tmp_path: Path) -> None:
    adapter = object.__new__(CreateFileWindowsFilesystem)
    temporary = tmp_path / ".partial.tmp"
    closed: list[int] = []
    deleted: list[Path] = []

    class Kernel:
        def CloseHandle(self, handle: int) -> None:
            closed.append(handle)

    adapter.kernel32 = Kernel()
    adapter._open = lambda *_args, **_kwargs: 17
    adapter._require_contained = lambda _handle: None
    adapter._write_chunks = lambda _handle, _content: (_ for _ in ()).throw(
        ProviderUnavailable("flush failed")
    )
    adapter.delete = deleted.append

    with pytest.raises(ProviderUnavailable):
        adapter._write_temporary(temporary, b"partial")

    assert closed == [17]
    assert deleted == [temporary]


def test_file_inventory_reserves_a_nullable_positive_encryption_version() -> None:
    column = File.__table__.c.enc_version
    checks = {
        str(constraint.sqltext)
        for constraint in File.__table__.constraints
        if isinstance(constraint, CheckConstraint)
    }

    assert column.nullable is True
    assert isinstance(column.type, SmallInteger)
    assert "enc_version IS NULL OR enc_version > 0" in checks
