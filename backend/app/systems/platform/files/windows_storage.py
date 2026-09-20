"""Windows handle-based private storage; never follows reparse points."""

import os
from hashlib import sha256
from pathlib import Path
from typing import Any, Protocol, cast
from uuid import uuid4

from app.systems.platform.files.providers import (
    ProviderRejected,
    ProviderUnavailable,
    ProviderWriteRejected,
    StorageStat,
)
from app.systems.platform.files.validation import MAX_BYTES


class WindowsFilesystem(Protocol):
    def write_new(self, path: Path, content: bytes) -> None: ...
    def read(self, path: Path, *, allow_oversized: bool = False) -> bytes | None: ...
    def delete(self, path: Path) -> None: ...


class WindowsLocalFilesystemStorage:
    """Storage behavior using a reparse-safe Windows filesystem adapter."""

    def __init__(self, root: Path, filesystem: WindowsFilesystem) -> None:
        self.root = root
        self.quarantine_root = root / "quarantine"
        self.objects_root = root / "objects"
        self.filesystem = filesystem

    def upload(self, key: str, content: bytes, media_type: str) -> None:
        del media_type
        if len(content) > MAX_BYTES:
            raise ProviderRejected("Storage object exceeds the configured limit")
        self.filesystem.write_new(self._path(key, quarantine=True), content)

    def read_quarantine(self, key: str) -> bytes | None:
        return self.filesystem.read(self._path(key, quarantine=True))

    def promote(self, key: str, *, expected_digest: str, expected_size: int) -> None:
        source = self.read_quarantine(key)
        if source is None:
            raise ProviderRejected("Quarantined storage object is unavailable")
        self._require_expected(source, expected_digest, expected_size)
        ready_path = self._path(key, quarantine=False)
        ready = self.filesystem.read(ready_path)
        if ready is None:
            self.filesystem.write_new(ready_path, source)
            ready = self.filesystem.read(ready_path)
        if ready is None:
            raise ProviderUnavailable("Ready storage object is unavailable")
        self._require_expected(ready, expected_digest, expected_size)

    def download(self, key: str) -> bytes | None:
        return self.filesystem.read(self._path(key, quarantine=False))

    def stat(self, key: str, *, quarantine: bool) -> StorageStat | None:
        content = self.filesystem.read(self._path(key, quarantine=quarantine))
        return None if content is None else StorageStat(len(content), sha256(content).hexdigest())

    def delete(self, key: str) -> None:
        for quarantine in (True, False):
            self.filesystem.delete(self._path(key, quarantine=quarantine))

    def _path(self, key: str, *, quarantine: bool) -> Path:
        if len(key) != 32 or any(character not in "0123456789abcdef" for character in key):
            raise ProviderRejected("Storage key is invalid")
        return (self.quarantine_root if quarantine else self.objects_root) / key[:2] / key

    @staticmethod
    def _require_expected(content: bytes, digest: str, size: int) -> None:
        if len(content) != size or sha256(content).hexdigest() != digest:
            raise ProviderRejected("Quarantined storage object integrity changed")


class CreateFileWindowsFilesystem:
    """CreateFileW adapter with final-handle containment and reparse rejection."""

    def __init__(self, root: Path) -> None:
        if os.name != "nt":
            raise ProviderUnavailable("Windows filesystem adapter is unavailable")
        import ctypes
        from ctypes import wintypes

        self.ctypes, self.wintypes = cast(Any, ctypes), cast(Any, wintypes)
        self.kernel32 = self.ctypes.WinDLL("kernel32", use_last_error=True)

        class FileInfo(ctypes.Structure):
            _fields_ = [
                ("attributes", wintypes.DWORD),
                ("creation_low", wintypes.DWORD),
                ("creation_high", wintypes.DWORD),
                ("access_low", wintypes.DWORD),
                ("access_high", wintypes.DWORD),
                ("write_low", wintypes.DWORD),
                ("write_high", wintypes.DWORD),
                ("volume_serial", wintypes.DWORD),
                ("size_high", wintypes.DWORD),
                ("size_low", wintypes.DWORD),
                ("links", wintypes.DWORD),
                ("index_high", wintypes.DWORD),
                ("index_low", wintypes.DWORD),
            ]

        class Disposition(ctypes.Structure):
            _fields_ = [("delete_file", wintypes.BOOL)]

        self.file_info = FileInfo
        self.disposition = Disposition
        self.kernel32.CreateFileW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.c_void_p,
            wintypes.DWORD,
            wintypes.DWORD,
            wintypes.HANDLE,
        ]
        self.kernel32.CreateFileW.restype = wintypes.HANDLE
        self.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel32.CloseHandle.restype = wintypes.BOOL
        self.kernel32.GetFileInformationByHandle.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(FileInfo),
        ]
        self.kernel32.GetFileInformationByHandle.restype = wintypes.BOOL
        self.kernel32.GetFinalPathNameByHandleW.argtypes = [
            wintypes.HANDLE,
            wintypes.LPWSTR,
            wintypes.DWORD,
            wintypes.DWORD,
        ]
        self.kernel32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
        self.kernel32.SetFileInformationByHandle.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        self.kernel32.SetFileInformationByHandle.restype = wintypes.BOOL
        self.kernel32.CreateHardLinkW.argtypes = [
            wintypes.LPCWSTR,
            wintypes.LPCWSTR,
            ctypes.c_void_p,
        ]
        self.kernel32.CreateHardLinkW.restype = wintypes.BOOL
        self.kernel32.WriteFile.argtypes = [
            wintypes.HANDLE,
            ctypes.c_void_p,
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
            ctypes.c_void_p,
        ]
        self.kernel32.WriteFile.restype = wintypes.BOOL
        self.kernel32.FlushFileBuffers.argtypes = [wintypes.HANDLE]
        self.kernel32.FlushFileBuffers.restype = wintypes.BOOL
        self.root = root.resolve(strict=False)
        try:
            root_handle = self._open(self.root, 0x80000000, 3, directory=True, share=0x00000003)
            self._require_contained(root_handle, permit_root=True)
            self.root_final = self._final_path(root_handle)
            for name in ("quarantine", "objects"):
                child = self.root / name
                try:
                    child.mkdir(mode=0o700)
                except FileExistsError:
                    pass
                handle = self._open(child, 0x80000000, 3, directory=True, share=0x00000003)
                try:
                    self._require_contained(handle)
                finally:
                    self.kernel32.CloseHandle(handle)
        except OSError as exc:
            raise ProviderUnavailable("Private storage root is unavailable") from exc
        finally:
            if "root_handle" in locals():
                self.kernel32.CloseHandle(root_handle)

    def write_new(self, path: Path, content: bytes) -> None:
        temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        location_handle = parent = source_handle = None
        temporary_created = False
        installation_completed = False
        try:
            location = path.parent.parent
            location_handle = self._open(location, 0x80000000, 3, directory=True, share=0x00000003)
            self._require_contained(location_handle)
            try:
                path.parent.mkdir(mode=0o700)
            except FileExistsError:
                pass
            parent = self._open(path.parent, 0x80000000, 3, directory=True, share=0x00000003)
            # Read/write sharing allows other shards while withholding delete/rename.
            self._require_contained(parent)
            source_handle = self._write_temporary(temporary, content)
            temporary_created = True
            self._require_contained(source_handle)
            if not self.kernel32.CreateHardLinkW(str(path), str(temporary), None):
                code = self.ctypes.get_last_error()
                if code == 80:
                    raise ProviderRejected("An immutable storage object already exists")
                raise ProviderWriteRejected(
                    "Private storage installation did not install the upload"
                )
            installation_completed = True
            installed = self.read(path)
            source_content = self.read(temporary)
            if installed != content or source_content != content:
                raise ProviderUnavailable("Private storage installation verification failed")
        except ProviderRejected:
            raise
        except ProviderUnavailable as exc:
            if not installation_completed:
                raise ProviderWriteRejected(
                    "Private storage write did not install the upload"
                ) from exc
            raise
        except OSError as exc:
            if not installation_completed:
                raise ProviderWriteRejected(
                    "Private storage write did not install the upload"
                ) from exc
            raise ProviderUnavailable("Private storage write is unavailable") from exc
        finally:
            if source_handle is not None:
                self.kernel32.CloseHandle(source_handle)
            if temporary_created and parent is not None:
                try:
                    self.delete(temporary)
                except ProviderUnavailable:
                    pass
            if parent is not None:
                self.kernel32.CloseHandle(parent)
            if location_handle is not None:
                self.kernel32.CloseHandle(location_handle)

    def _write_temporary(self, path: Path, content: bytes) -> int:
        handle: int | None = None
        created = False
        completed = False
        try:
            # Write, CREATE_NEW, read share.
            handle = self._open(path, 0x40000000, 1, share=0x00000001)
            created = True
            self._require_contained(handle)
            self._write_chunks(handle, content)
            completed = True
            return handle
        except FileExistsError:
            raise ProviderWriteRejected(
                "Private storage temporary creation is unavailable"
            ) from None
        except OSError as exc:
            raise ProviderWriteRejected("Private storage write did not install the upload") from exc
        finally:
            if not completed and handle is not None:
                self.kernel32.CloseHandle(handle)
            if not completed and created:
                try:
                    self.delete(path)
                except ProviderUnavailable:
                    pass

    def _write_chunks(self, handle: int, content: bytes) -> None:
        for offset in range(0, len(content), 1024 * 1024):
            chunk = content[offset : offset + 1024 * 1024]
            buffer = self.ctypes.create_string_buffer(chunk)
            written = self.wintypes.DWORD()
            if not self.kernel32.WriteFile(
                handle, buffer, len(chunk), self.ctypes.byref(written), None
            ) or written.value != len(chunk):
                raise ProviderUnavailable("Private storage write is incomplete")
        if not self.kernel32.FlushFileBuffers(handle):
            raise ProviderUnavailable("Private storage flush is unavailable")

    def read(self, path: Path, *, allow_oversized: bool = False) -> bytes | None:
        handle: int | None
        try:
            handle = self._open(
                path, 0x80000000, 3, share=0x00000003
            )  # read, OPEN_EXISTING, read/write shares
        except FileNotFoundError:
            return None
        try:
            self._require_contained(handle)
            descriptor = __import__("msvcrt").open_osfhandle(handle, 0)
            handle = None
            with os.fdopen(descriptor, "rb") as stream:
                content = stream.read(MAX_BYTES + 1)
            if not allow_oversized and len(content) > MAX_BYTES:
                raise ProviderUnavailable("Private storage object exceeds the configured limit")
            return content
        except OSError as exc:
            raise ProviderUnavailable("Private storage read is unavailable") from exc
        finally:
            if handle is not None:
                self.kernel32.CloseHandle(handle)

    def delete(self, path: Path) -> None:
        try:
            handle = self._open(path, 0x00010000, 3)  # DELETE, OPEN_EXISTING
        except FileNotFoundError:
            return
        try:
            self._require_contained(handle)
            disposition = self.disposition(True)
            if not self.kernel32.SetFileInformationByHandle(
                handle, 4, self.ctypes.byref(disposition), self.ctypes.sizeof(disposition)
            ):
                raise ProviderUnavailable("Private storage deletion is unavailable")
        finally:
            self.kernel32.CloseHandle(handle)

    def _open(
        self, path: Path, access: int, disposition: int, *, directory: bool = False, share: int = 0
    ) -> int:
        flags = 0x80 | 0x00200000 | 0x80000000  # normal, OPEN_REPARSE_POINT, write-through
        if directory:
            flags |= 0x02000000  # FILE_FLAG_BACKUP_SEMANTICS
        handle = self.kernel32.CreateFileW(str(path), access, share, None, disposition, flags, None)
        invalid = self.wintypes.HANDLE(-1).value
        if handle == invalid:
            code = self.ctypes.get_last_error()
            if code in {2, 3}:
                raise FileNotFoundError from None
            if code == 80:
                raise FileExistsError from None
            raise ProviderUnavailable("Private storage handle is unavailable")
        return cast(int, handle)

    def _final_directory(self, path: Path) -> str:
        handle = self._open(path, 0x80000000, 3, directory=True)
        try:
            self._require_contained(handle, permit_root=True)
            return self._final_path(handle)
        finally:
            self.kernel32.CloseHandle(handle)

    def _require_contained(self, handle: int, *, permit_root: bool = False) -> None:
        info = self.file_info()
        if not self.kernel32.GetFileInformationByHandle(handle, self.ctypes.byref(info)):
            raise ProviderUnavailable("Private storage handle information is unavailable")
        if info.attributes & 0x400:  # FILE_ATTRIBUTE_REPARSE_POINT
            raise ProviderUnavailable("Private storage reparse points are not permitted")
        final = self._final_path(handle)
        if not permit_root and os.path.commonpath((self.root_final, final)) != self.root_final:
            raise ProviderUnavailable("Private storage handle escaped its root")

    def _final_path(self, handle: int) -> str:
        buffer = self.ctypes.create_unicode_buffer(32768)
        size = self.kernel32.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 0)
        if not size or size >= len(buffer):
            raise ProviderUnavailable("Private storage final path is unavailable")
        return cast(str, os.path.normcase(buffer.value.removeprefix("\\\\?\\")))
