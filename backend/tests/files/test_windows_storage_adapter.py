"""Cross-platform contracts for the CreateFileW private-file adapter."""

from __future__ import annotations

import sys
from collections.abc import Callable
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from app.systems.platform.files import windows_storage
from app.systems.platform.files.providers import ProviderRejected, ProviderUnavailable
from app.systems.platform.files.windows_storage import (
    CreateFileWindowsFilesystem,
    WindowsLocalFilesystemStorage,
)


class _Call:
    def __init__(self, callback: Callable[..., Any]) -> None:
        self.callback = callback
        self.argtypes: object | None = None
        self.restype: object | None = None

    def __call__(self, *args: object) -> Any:
        return self.callback(*args)


class _Kernel:
    def __init__(self) -> None:
        self.closed: list[int] = []
        self.paths: dict[int, str] = {}
        self.next_handle = 10
        self.write_ok = True
        self.flush_ok = True
        self.link_ok = True
        self.delete_ok = True
        self.attributes = 0
        self.CreateFileW = _Call(self._create_file)
        self.CloseHandle = _Call(self._close)
        self.GetFileInformationByHandle = _Call(self._information)
        self.GetFinalPathNameByHandleW = _Call(self._final_path)
        self.SetFileInformationByHandle = _Call(self._set_information)
        self.CreateHardLinkW = _Call(self._hard_link)
        self.WriteFile = _Call(self._write)
        self.FlushFileBuffers = _Call(self._flush)

    def _create_file(
        self,
        path: object,
        _access: object,
        _share: object,
        _security: object,
        _disposition: object,
        _flags: object,
        _template: object,
    ) -> int:
        handle = self.next_handle
        self.next_handle += 1
        self.paths[handle] = str(path)
        return handle

    def _close(self, handle: object) -> bool:
        self.closed.append(int(handle))
        return True

    def _information(self, _handle: object, info: object) -> bool:
        info.attributes = self.attributes
        return True

    def _final_path(self, handle: object, buffer: object, _size: object, _flags: object) -> int:
        buffer.value = "\\\\?\\" + self.paths[int(handle)]
        return len(buffer.value)

    def _set_information(
        self, _handle: object, _kind: object, _info: object, _size: object
    ) -> bool:
        return self.delete_ok

    def _hard_link(self, _target: object, _source: object, _security: object) -> bool:
        return self.link_ok

    def _write(
        self, _handle: object, _data: object, size: object, written: object, _unused: object
    ) -> bool:
        written.value = int(size)
        return self.write_ok

    def _flush(self, _handle: object) -> bool:
        return self.flush_ok


class _Buffer:
    def __init__(self, _size: int) -> None:
        self.value = ""

    def __len__(self) -> int:
        return 32768


class _Stream:
    def __init__(self, content: bytes) -> None:
        self.content = content

    def __enter__(self) -> _Stream:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, _limit: int) -> bytes:
        return self.content


class _MemoryFilesystem:
    def __init__(self) -> None:
        self.contents: dict[Path, bytes] = {}
        self.drop_ready_write = False

    def write_new(self, path: Path, content: bytes) -> None:
        if self.drop_ready_write and "objects" in path.parts:
            return
        self.contents[path] = content

    def read(self, path: Path, *, allow_oversized: bool = False) -> bytes | None:
        del allow_oversized
        return self.contents.get(path)

    def delete(self, path: Path) -> None:
        self.contents.pop(path, None)


def _adapter(kernel: _Kernel | None = None) -> CreateFileWindowsFilesystem:
    adapter = object.__new__(CreateFileWindowsFilesystem)
    adapter.kernel32 = kernel or _Kernel()
    adapter.ctypes = SimpleNamespace(
        byref=lambda value: value,
        sizeof=lambda _value: 4,
        create_string_buffer=lambda value: value,
        create_unicode_buffer=_Buffer,
        get_last_error=lambda: 5,
    )
    adapter.wintypes = SimpleNamespace(
        DWORD=lambda: SimpleNamespace(value=0), HANDLE=lambda value: SimpleNamespace(value=value)
    )
    adapter.file_info = lambda: SimpleNamespace(attributes=0)
    adapter.disposition = lambda delete_file: SimpleNamespace(delete_file=delete_file)
    adapter.root_final = "/private"
    return adapter


def test_adapter_initialization_opens_and_validates_root_and_storage_directories(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kernel = _Kernel()
    ctypes_module = ModuleType("ctypes")

    class _Structure:
        pass

    ctypes_module.Structure = _Structure
    ctypes_module.c_void_p = object
    ctypes_module.c_int = int
    ctypes_module.byref = lambda value: value
    ctypes_module.create_unicode_buffer = _Buffer
    ctypes_module.POINTER = lambda value: value
    ctypes_module.WinDLL = lambda _name, use_last_error: kernel
    ctypes_module.wintypes = SimpleNamespace(
        DWORD=int,
        BOOL=int,
        HANDLE=lambda value: SimpleNamespace(value=value),
        LPCWSTR=str,
        LPWSTR=str,
    )
    monkeypatch.setitem(sys.modules, "ctypes", ctypes_module)
    monkeypatch.setattr(
        windows_storage,
        "os",
        SimpleNamespace(name="nt", path=windows_storage.os.path, fdopen=windows_storage.os.fdopen),
    )

    root = tmp_path / "private"
    with pytest.raises(ProviderUnavailable, match="root"):
        CreateFileWindowsFilesystem(root)
    root.mkdir()
    adapter = CreateFileWindowsFilesystem(root)

    assert adapter.root_final.endswith("/private")
    assert (tmp_path / "private" / "quarantine").is_dir()
    assert (tmp_path / "private" / "objects").is_dir()
    assert sorted(kernel.closed) == [10, 11, 12, 13]
    assert adapter.kernel32.CreateFileW.argtypes is not None


def test_adapter_initialization_translates_unavailable_root_and_closes_handle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    kernel = _Kernel()
    kernel.GetFileInformationByHandle = _Call(lambda _handle, _info: False)
    ctypes_module = ModuleType("ctypes")
    ctypes_module.Structure = type("Structure", (), {})
    ctypes_module.c_void_p = object
    ctypes_module.c_int = int
    ctypes_module.byref = lambda value: value
    ctypes_module.create_unicode_buffer = _Buffer
    ctypes_module.POINTER = lambda value: value
    ctypes_module.WinDLL = lambda _name, use_last_error: kernel
    ctypes_module.wintypes = SimpleNamespace(
        DWORD=int,
        BOOL=int,
        HANDLE=lambda value: SimpleNamespace(value=value),
        LPCWSTR=str,
        LPWSTR=str,
    )
    monkeypatch.setitem(sys.modules, "ctypes", ctypes_module)
    monkeypatch.setattr(
        windows_storage,
        "os",
        SimpleNamespace(name="nt", path=windows_storage.os.path, fdopen=windows_storage.os.fdopen),
    )

    root = tmp_path / "private"
    root.mkdir()
    with pytest.raises(ProviderUnavailable, match="handle information"):
        CreateFileWindowsFilesystem(root)

    assert kernel.closed == [10]


def test_windows_storage_facade_rejects_bad_keys_and_preserves_integrity(tmp_path: Path) -> None:
    filesystem = _MemoryFilesystem()
    storage = WindowsLocalFilesystemStorage(tmp_path / "private", filesystem)
    key = "a" * 32
    content = b"content"

    storage.upload(key, content, "application/octet-stream")
    assert storage.stat(key, quarantine=True).size == len(content)
    storage.delete(key)
    assert storage.stat(key, quarantine=True) is None

    with pytest.raises(ProviderRejected, match="configured limit"):
        storage.upload(key, b"x" * (windows_storage.MAX_BYTES + 1), "application/octet-stream")
    with pytest.raises(ProviderRejected, match="key"):
        storage.download("invalid")
    with pytest.raises(ProviderRejected, match="integrity"):
        storage._require_expected(content, "0" * 64, len(content))


def test_windows_storage_facade_reports_missing_quarantine_and_ready_write(tmp_path: Path) -> None:
    filesystem = _MemoryFilesystem()
    storage = WindowsLocalFilesystemStorage(tmp_path / "private", filesystem)
    key = "b" * 32

    with pytest.raises(ProviderRejected, match="Quarantined"):
        storage.promote(key, expected_digest="0" * 64, expected_size=0)

    storage.upload(key, b"content", "application/octet-stream")
    filesystem.drop_ready_write = True
    with pytest.raises(ProviderUnavailable, match="Ready"):
        storage.promote(
            key,
            expected_digest=windows_storage.sha256(b"content").hexdigest(),
            expected_size=7,
        )


@pytest.mark.parametrize(
    ("last_error", "expected"),
    [
        (2, FileNotFoundError),
        (3, FileNotFoundError),
        (80, FileExistsError),
        (5, ProviderUnavailable),
    ],
)
def test_open_maps_win32_errors_without_returning_invalid_handle(
    tmp_path: Path, last_error: int, expected: type[Exception]
) -> None:
    kernel = _Kernel()
    kernel.CreateFileW = _Call(lambda *_args: -1)
    adapter = _adapter(kernel)
    adapter.ctypes.get_last_error = lambda: last_error

    with pytest.raises(expected):
        adapter._open(tmp_path / "object", 1, 3, directory=True, share=2)


def test_containment_rejects_reparse_paths_and_handles_outside_private_root() -> None:
    adapter = _adapter()
    adapter.kernel32.attributes = 0x400

    with pytest.raises(ProviderUnavailable, match="reparse"):
        adapter._require_contained(1)

    adapter.kernel32.attributes = 0
    adapter._final_path = lambda _handle: "/outside/file"
    with pytest.raises(ProviderUnavailable, match="escaped"):
        adapter._require_contained(1)


def test_final_directory_and_delete_close_handles_on_success_and_failures(tmp_path: Path) -> None:
    adapter = _adapter()
    adapter._open = lambda *_args, **_kwargs: 31
    adapter._final_path = lambda _handle: "/private/objects"
    adapter._require_contained = lambda *_args, **_kwargs: None

    assert adapter._final_directory(tmp_path / "objects") == "/private/objects"
    adapter.delete(tmp_path / "file")
    assert adapter.kernel32.closed == [31, 31]

    adapter._open = lambda *_args, **_kwargs: (_ for _ in ()).throw(FileNotFoundError())
    adapter.delete(tmp_path / "missing")
    assert adapter.kernel32.closed == [31, 31]

    adapter._open = lambda *_args, **_kwargs: 32
    adapter.kernel32.delete_ok = False
    with pytest.raises(ProviderUnavailable, match="deletion"):
        adapter.delete(tmp_path / "cannot-delete")
    assert adapter.kernel32.closed[-1] == 32


def test_read_enforces_size_limit_and_translates_stream_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    adapter = _adapter()
    adapter._open = lambda *_args, **_kwargs: 44
    adapter._require_contained = lambda _handle: None
    monkeypatch.setitem(
        sys.modules, "msvcrt", SimpleNamespace(open_osfhandle=lambda _handle, _flags: 8)
    )
    monkeypatch.setattr(windows_storage.os, "fdopen", lambda _fd, _mode: _Stream(b"file"))

    assert adapter.read(tmp_path / "file") == b"file"
    assert adapter.kernel32.closed == []

    monkeypatch.setattr(
        windows_storage.os,
        "fdopen",
        lambda _fd, _mode: _Stream(b"x" * (windows_storage.MAX_BYTES + 1)),
    )
    with pytest.raises(ProviderUnavailable, match="exceeds"):
        adapter.read(tmp_path / "too-large")
    assert adapter.read(tmp_path / "too-large", allow_oversized=True) is not None

    adapter._open = lambda *_args, **_kwargs: (_ for _ in ()).throw(FileNotFoundError())
    assert adapter.read(tmp_path / "missing") is None


def test_write_new_verifies_immutable_link_and_cleans_temporary_handle(tmp_path: Path) -> None:
    kernel = _Kernel()
    adapter = _adapter(kernel)
    path = tmp_path / "objects" / "ab" / ("a" * 32)
    path.parent.parent.mkdir()
    temporary_paths: list[Path] = []
    contents: dict[Path, bytes] = {}

    adapter._open = lambda *_args, **_kwargs: 51
    adapter._require_contained = lambda _handle: None

    def write_temporary(temporary: Path, content: bytes) -> int:
        temporary_paths.append(temporary)
        contents[temporary] = content
        return 52

    def read(path_to_read: Path, *, allow_oversized: bool = False) -> bytes | None:
        del allow_oversized
        if path_to_read == path:
            return contents[temporary_paths[0]]
        return contents.get(path_to_read)

    deleted: list[Path] = []
    adapter._write_temporary = write_temporary
    adapter.read = read
    adapter.delete = deleted.append

    adapter.write_new(path, b"verified")

    assert temporary_paths and deleted == temporary_paths
    assert kernel.closed == [52, 51, 51]

    kernel.link_ok = False
    with pytest.raises(ProviderUnavailable, match="installation"):
        adapter.write_new(path, b"verified")
    assert kernel.closed[-3:] == [52, 51, 51]


def test_write_new_rejects_existing_immutable_object_and_cleans_temporary(tmp_path: Path) -> None:
    kernel = _Kernel()
    kernel.link_ok = False
    adapter = _adapter(kernel)
    adapter.ctypes.get_last_error = lambda: 80
    path = tmp_path / "objects" / "ab" / ("b" * 32)
    path.parent.parent.mkdir()
    adapter._open = lambda *_args, **_kwargs: 61
    adapter._require_contained = lambda _handle: None
    adapter._write_temporary = lambda _path, _content: 62
    deleted: list[Path] = []
    adapter.delete = deleted.append

    with pytest.raises(ProviderRejected, match="immutable"):
        adapter.write_new(path, b"verified")

    assert len(deleted) == 1
    assert kernel.closed == [62, 61, 61]


@pytest.mark.parametrize("failure", [FileExistsError, OSError])
def test_temporary_create_failure_never_deletes_or_closes_an_existing_file(
    tmp_path: Path, failure: type[OSError]
) -> None:
    adapter = _adapter()
    adapter._open = lambda *_args, **_kwargs: (_ for _ in ()).throw(failure())
    deleted: list[Path] = []
    adapter.delete = deleted.append

    with pytest.raises(ProviderUnavailable, match="temporary creation|write"):
        adapter._write_temporary(tmp_path / ".existing.tmp", b"content")

    assert deleted == []
    assert adapter.kernel32.closed == []
