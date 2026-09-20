"""Private local immutable object storage for the FastAPI process."""

import os
import re
import stat as stat_module
from collections.abc import Iterator
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from typing import cast
from uuid import uuid4

from app.core.config import get_settings
from app.systems.platform.files.providers import (
    ProviderRejected,
    ProviderUnavailable,
    ProviderWriteRejected,
    StorageBackend,
    StorageStat,
)
from app.systems.platform.files.validation import MAX_BYTES

_KEY = re.compile(r"[0-9a-f]{32}\Z")
_NOFOLLOW = cast(int | None, getattr(os, "O_NOFOLLOW", None))


class LocalFilesystemStorage:
    """Immutable opaque objects split between quarantine and ready locations."""

    def __init__(self, root: Path) -> None:
        self._windows = None
        if os.name == "nt":
            from app.systems.platform.files.windows_storage import (
                CreateFileWindowsFilesystem,
                WindowsLocalFilesystemStorage,
            )

            self._windows = WindowsLocalFilesystemStorage(root, CreateFileWindowsFilesystem(root))
            self.root = self._windows.root
            self.quarantine_root = self._windows.quarantine_root
            self.objects_root = self._windows.objects_root
            return
        if _NOFOLLOW is None:
            raise ProviderUnavailable("Private storage requires no-follow filesystem operations")
        self.root = root.expanduser().resolve(strict=False)
        self.quarantine_root = self.root / "quarantine"
        self.objects_root = self.root / "objects"
        try:
            self._ensure_private_directory(self.root)
            self._ensure_private_directory(self.quarantine_root)
            self._ensure_private_directory(self.objects_root)
        except OSError as exc:
            raise ProviderUnavailable("Private storage is unavailable") from exc

    def upload(self, key: str, content: bytes, media_type: str) -> None:
        if self._windows is not None:
            self._windows.upload(key, content, media_type)
            return
        del media_type
        if len(content) > MAX_BYTES:
            raise ProviderRejected("Storage object exceeds the configured limit")
        self._validate_key(key)
        temporary = f".{key}.{uuid4().hex}.tmp"
        installed = False
        link_attempted = False
        try:
            with self._shard(key, quarantine=True) as shard:
                descriptor = os.open(
                    temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=shard
                )
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                link_attempted = True
                os.link(
                    temporary,
                    key,
                    src_dir_fd=shard,
                    dst_dir_fd=shard,
                    follow_symlinks=False,
                )
                installed = True
                os.fsync(shard)
                os.unlink(temporary, dir_fd=shard)
                os.fsync(shard)
        except FileExistsError as exc:
            if not link_attempted:
                raise ProviderWriteRejected("Private storage did not install the upload") from exc
            raise ProviderRejected("An immutable storage object already exists") from exc
        except OSError as exc:
            if not installed:
                raise ProviderWriteRejected("Private storage did not install the upload") from exc
            raise ProviderUnavailable("Private storage write is unavailable") from exc
        finally:
            self._remove_temporary(key, temporary)

    def read_quarantine(self, key: str) -> bytes | None:
        if self._windows is not None:
            return self._windows.read_quarantine(key)
        return self._read(key, quarantine=True)

    def promote(self, key: str, *, expected_digest: str, expected_size: int) -> None:
        if self._windows is not None:
            self._windows.promote(key, expected_digest=expected_digest, expected_size=expected_size)
            return
        self._validate_expected(expected_digest, expected_size)
        try:
            with self._shard(key, quarantine=True) as quarantine, self._shard(
                key, quarantine=False
            ) as objects:
                source = self._regular_stat(quarantine, key)
                if source is None:
                    raise ProviderRejected("Quarantined storage object is unavailable")
                self._verify_expected(quarantine, key, source, expected_digest, expected_size)
                destination = self._regular_stat(objects, key)
                if destination is not None:
                    self._verify_expected(objects, key, destination, expected_digest, expected_size)
                    return
                os.link(
                    key,
                    key,
                    src_dir_fd=quarantine,
                    dst_dir_fd=objects,
                    follow_symlinks=False,
                )
                os.fsync(objects)
                destination = self._regular_stat(objects, key)
                if destination is None:
                    raise OSError("ready storage object disappeared during promotion")
                try:
                    self._verify_expected(objects, key, destination, expected_digest, expected_size)
                except ProviderRejected:
                    self._unlink_if_same(objects, key, destination)
                    os.fsync(objects)
                    raise
        except ProviderRejected:
            raise
        except OSError as exc:
            raise ProviderUnavailable("Private storage promotion is unavailable") from exc

    def download(self, key: str) -> bytes | None:
        if self._windows is not None:
            return self._windows.download(key)
        return self._read(key, quarantine=False)

    def stat(self, key: str, *, quarantine: bool) -> StorageStat | None:
        if self._windows is not None:
            return self._windows.stat(key, quarantine=quarantine)
        try:
            with self._shard(key, quarantine=quarantine) as shard:
                metadata = self._regular_stat(shard, key)
                if metadata is None:
                    return None
                content = self._read_exact(shard, key, metadata)
        except OSError as exc:
            raise ProviderUnavailable("Private storage read is unavailable") from exc
        return StorageStat(size=len(content), digest=sha256(content).hexdigest())

    def delete(self, key: str) -> None:
        if self._windows is not None:
            self._windows.delete(key)
            return
        try:
            for quarantine in (True, False):
                with self._shard(key, quarantine=quarantine) as shard:
                    metadata = self._regular_stat(shard, key, allow_oversized=True)
                    if metadata is None:
                        continue
                    self._unlink_if_same(shard, key, metadata)
                    os.fsync(shard)
        except OSError as exc:
            raise ProviderUnavailable("Private storage deletion is unavailable") from exc

    def _read(self, key: str, *, quarantine: bool) -> bytes | None:
        try:
            with self._shard(key, quarantine=quarantine) as shard:
                metadata = self._regular_stat(shard, key)
                return None if metadata is None else self._read_exact(shard, key, metadata)
        except OSError as exc:
            raise ProviderUnavailable("Private storage read is unavailable") from exc

    @contextmanager
    def _shard(self, key: str, *, quarantine: bool) -> Iterator[int]:
        self._validate_key(key)
        root = self._open_directory_path(self.root)
        location_name = "quarantine" if quarantine else "objects"
        location = prefix = None
        try:
            location = self._open_directory_at(root, location_name)
            prefix = self._open_directory_at(location, key[:2], create=True)
            yield prefix
        finally:
            if prefix is not None:
                os.close(prefix)
            if location is not None:
                os.close(location)
            os.close(root)

    def _ensure_private_directory(self, path: Path) -> None:
        created = False
        try:
            os.mkdir(path, 0o700)
        except FileExistsError:
            pass
        else:
            created = True
        if created:
            parent = self._open_directory_path(path.parent)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        descriptor = self._open_directory_path(path)
        try:
            os.fchmod(descriptor, 0o700)
        finally:
            os.close(descriptor)

    @staticmethod
    def _directory_flags() -> int:
        assert _NOFOLLOW is not None
        return os.O_RDONLY | _NOFOLLOW | int(getattr(os, "O_DIRECTORY", 0))

    def _open_directory_path(self, path: Path) -> int:
        descriptor = os.open(path, self._directory_flags())
        self._require_directory(descriptor)
        return descriptor

    def _open_directory_at(self, parent: int, name: str, *, create: bool = False) -> int:
        if create:
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
            except FileExistsError:
                pass
            else:
                os.fsync(parent)
        descriptor = os.open(name, self._directory_flags(), dir_fd=parent)
        try:
            self._require_directory(descriptor)
            os.fchmod(descriptor, 0o700)
        except Exception:
            os.close(descriptor)
            raise
        return descriptor

    @staticmethod
    def _require_directory(descriptor: int) -> None:
        if not stat_module.S_ISDIR(os.fstat(descriptor).st_mode):
            raise OSError("private storage path is not a directory")

    @staticmethod
    def _regular_stat(
        directory: int, key: str, *, allow_oversized: bool = False
    ) -> os.stat_result | None:
        try:
            metadata = os.stat(key, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            return None
        if not stat_module.S_ISREG(metadata.st_mode):
            raise OSError("private storage object is not a regular file")
        if not allow_oversized and metadata.st_size > MAX_BYTES:
            raise OSError("private storage object exceeds the configured limit")
        return metadata

    @staticmethod
    def _read_exact(directory: int, key: str, metadata: os.stat_result) -> bytes:
        assert _NOFOLLOW is not None
        descriptor = os.open(key, os.O_RDONLY | _NOFOLLOW, dir_fd=directory)
        try:
            opened = os.fstat(descriptor)
            if (
                not stat_module.S_ISREG(opened.st_mode)
                or opened.st_dev != metadata.st_dev
                or opened.st_ino != metadata.st_ino
                or opened.st_size != metadata.st_size
                or opened.st_size > MAX_BYTES
            ):
                raise OSError("private storage object changed during read")
            with os.fdopen(descriptor, "rb", closefd=False) as stream:
                content = stream.read(MAX_BYTES + 1)
            if len(content) != opened.st_size or len(content) > MAX_BYTES:
                raise OSError("private storage object changed during read")
            return content
        finally:
            os.close(descriptor)

    @staticmethod
    def _unlink_if_same(directory: int, key: str, expected: os.stat_result) -> None:
        current = LocalFilesystemStorage._regular_stat(directory, key, allow_oversized=True)
        if current is None:
            return
        if current.st_dev != expected.st_dev or current.st_ino != expected.st_ino:
            raise OSError("private storage object changed before deletion")
        os.unlink(key, dir_fd=directory)

    @staticmethod
    def _validate_key(key: str) -> None:
        if not _KEY.fullmatch(key):
            raise ProviderRejected("Storage key is invalid")

    @staticmethod
    def _validate_expected(digest: str, size: int) -> None:
        if not re.fullmatch(r"[0-9a-f]{64}", digest) or not 0 < size <= MAX_BYTES:
            raise ProviderRejected("Storage integrity expectation is invalid")

    @staticmethod
    def _verify_expected(
        directory: int,
        key: str,
        metadata: os.stat_result,
        digest: str,
        size: int,
    ) -> None:
        content = LocalFilesystemStorage._read_exact(directory, key, metadata)
        if len(content) != size or sha256(content).hexdigest() != digest:
            raise ProviderRejected("Quarantined storage object integrity changed")

    def _remove_temporary(self, key: str, temporary: str) -> None:
        try:
            with self._shard(key, quarantine=True) as shard:
                os.unlink(temporary, dir_fd=shard)
                os.fsync(shard)
        except FileNotFoundError:
            pass
        except OSError:
            pass


def get_storage() -> StorageBackend:
    try:
        return LocalFilesystemStorage(get_settings().files_storage_root)
    except ProviderUnavailable as error:
        from fastapi import HTTPException

        raise HTTPException(
            503, detail={"code": "storage_unavailable", "message": "Storage is unavailable"}
        ) from error
