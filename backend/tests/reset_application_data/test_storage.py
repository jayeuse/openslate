"""Private-filesystem safety contracts for the local reset utility."""

from __future__ import annotations

import socket

import pytest

from operations.reset_models import ResetError
from operations.reset_storage import ResetStorage, require_api_stopped


def _private_root(tmp_path):
    root = tmp_path / "private-files"
    (root / "objects" / "aa").mkdir(parents=True)
    (root / "quarantine" / "bb").mkdir(parents=True)
    return root


def test_private_storage_inventory_deletes_confirmed_files_and_proves_empty(tmp_path) -> None:
    root = _private_root(tmp_path)
    (root / "objects" / "aa" / "ready").write_bytes(b"ready")
    (root / "quarantine" / "bb" / "pending").write_bytes(b"pending")
    storage = ResetStorage(root)

    inventory = storage.list_object_keys()

    assert inventory == ("objects/aa/ready", "quarantine/bb/pending")
    storage.delete_and_verify_empty(inventory)
    assert storage.list_object_keys() == ()


def test_private_storage_rejects_symlinked_inventory_and_escape_plan(tmp_path) -> None:
    root = _private_root(tmp_path)
    outside = tmp_path / "outside"
    outside.write_bytes(b"private")
    (root / "objects" / "aa" / "escape").symlink_to(outside)
    storage = ResetStorage(root)

    with pytest.raises(ResetError, match="inventory"):
        storage.list_object_keys()
    with pytest.raises(ResetError, match="inventory"):
        storage.delete_and_verify_empty(("objects/../../outside",))
    assert outside.read_bytes() == b"private"


def test_private_storage_rejects_missing_or_symlinked_root(tmp_path) -> None:
    with pytest.raises(ResetError, match="FILES_STORAGE_ROOT"):
        ResetStorage(tmp_path / "missing")

    target = _private_root(tmp_path)
    link = tmp_path / "link"
    link.symlink_to(target, target_is_directory=True)
    with pytest.raises(ResetError, match="FILES_STORAGE_ROOT"):
        ResetStorage(link)


def test_private_storage_rejects_directory_replacement_and_inventory_errors(
    tmp_path, monkeypatch
) -> None:
    root = _private_root(tmp_path)
    object_path = root / "objects" / "aa" / "ready"
    object_path.write_bytes(b"ready")
    storage = ResetStorage(root)
    inventory = storage.list_object_keys()
    (root / "objects").rename(root / "objects-old")
    (root / "objects").mkdir()
    with pytest.raises(ResetError, match="plan changed"):
        storage.delete_and_verify_empty(inventory)

    root = _private_root(tmp_path / "replaced-root")
    storage = ResetStorage(root)
    root.rename(tmp_path / "replaced-root-old")
    _private_root(tmp_path / "replaced-root")
    with pytest.raises(ResetError, match="inventory"):
        storage.list_object_keys()

    root = _private_root(tmp_path / "second")
    storage = ResetStorage(root)
    monkeypatch.setattr(
        "operations.reset_storage.os.listdir", lambda _fd: (_ for _ in ()).throw(OSError())
    )
    with pytest.raises(ResetError, match="inventory"):
        storage.list_object_keys()


def test_api_writer_admission_is_cross_platform_and_fail_closed(monkeypatch) -> None:
    def refused(*_args, **_kwargs):
        raise ConnectionRefusedError

    monkeypatch.setattr(socket, "create_connection", refused)
    assert require_api_stopped("127.0.0.1", "8000") is None
    assert require_api_stopped("::1", "8000") is None

    class Connected:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

    monkeypatch.setattr(socket, "create_connection", lambda *_args, **_kwargs: Connected())
    with pytest.raises(ResetError, match="must be stopped"):
        require_api_stopped("::", "8000")
    with pytest.raises(ResetError, match="valid"):
        require_api_stopped("127.0.0.1", "invalid")
    with pytest.raises(ResetError, match="not supported"):
        require_api_stopped("192.168.1.10", "8000")
