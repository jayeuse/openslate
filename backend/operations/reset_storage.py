"""Descriptor-safe private-filesystem cleanup for the local application reset."""

from __future__ import annotations

import errno
import os
import socket
import stat
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

if __package__:
    from .reset_models import ResetError  # type: ignore[import-not-found]
else:
    from reset_models import ResetError

_NOFOLLOW = int(getattr(os, "O_NOFOLLOW", 0))
_DIRECTORY = getattr(os, "O_DIRECTORY", 0)
_READONLY = os.O_RDONLY | _DIRECTORY


def require_api_stopped(backend_host: str, backend_port: str) -> None:
    """Reject reset while the configured IPv4/IPv6 API listener accepts connections."""
    try:
        port = int(backend_port)
        if not 1 <= port <= 65535:
            raise ValueError
    except (TypeError, ValueError):
        raise ResetError("BACKEND_PORT must be a valid local API port") from None
    targets = {
        "127.0.0.1": (("127.0.0.1", port),),
        "localhost": (("127.0.0.1", port), ("::1", port)),
        "::1": (("::1", port),),
        "0.0.0.0": (("127.0.0.1", port),),
        "::": (("127.0.0.1", port), ("::1", port)),
    }.get(backend_host)
    if targets is None:
        raise ResetError("BACKEND_BIND_HOST is not supported for local reset")
    for target in targets:
        try:
            with socket.create_connection(target, timeout=0.5):
                raise ResetError("The API server must be stopped before reset")
        except ConnectionRefusedError:
            continue
        except OSError as error:
            if error.errno in {errno.ECONNREFUSED, errno.EADDRNOTAVAIL}:
                continue
            raise ResetError("Unable to verify that the API server is stopped") from None


class ResetStorage:
    """Delete regular private files only through retained, no-follow directory descriptors."""

    _LOCATIONS = ("quarantine", "objects")

    def __init__(self, root: str | Path) -> None:
        if os.name == "nt" or _NOFOLLOW == 0:
            raise ResetError("Private storage reset requires native safe handle support")
        try:
            path = Path(root).expanduser()
            if not path.is_absolute() or path.is_symlink():
                raise ValueError
            self.root = path.resolve(strict=True)
            self._root_fd = self._open_directory_path(self.root)
            self._root_identity = self._identity(os.fstat(self._root_fd))
            for location in self._LOCATIONS:
                with self._location(location):
                    pass
            self._inventory_identities: dict[str, tuple[int, int]] = {}
        except (OSError, TypeError, ValueError):
            if "_root_fd" in self.__dict__:
                os.close(self._root_fd)
            raise ResetError(
                "FILES_STORAGE_ROOT must be an existing private storage root"
            ) from None

    def __del__(self) -> None:
        descriptor = getattr(self, "_root_fd", None)
        if isinstance(descriptor, int):
            try:
                os.close(descriptor)
            except OSError:
                pass

    def list_object_keys(self) -> tuple[str, ...]:
        """Inventory regular objects and retain their inode identity for a confirmed plan."""
        identities: dict[str, tuple[int, int]] = {}
        try:
            self._assert_root_current()
            for location in self._LOCATIONS:
                with self._location(location) as descriptor:
                    self._walk(descriptor, (location,), identities)
            self._assert_root_current()
        except (OSError, ValueError):
            raise ResetError("Private storage inventory is unavailable") from None
        keys = tuple(sorted(identities))
        if len(keys) != len(identities):
            raise ResetError("Private storage inventory is ambiguous")
        self._inventory_identities = identities
        return keys

    def delete_and_verify_empty(self, object_keys: Sequence[str]) -> None:
        """Delete only unchanged confirmed files, then re-inventory through directory handles."""
        expected = tuple(object_keys)
        if tuple(sorted(expected)) != expected or len(set(expected)) != len(expected):
            raise ResetError("Private storage cleanup plan is invalid")
        if self.list_object_keys() != expected:
            raise ResetError("Private storage cleanup plan changed; run a fresh dry run")
        for key in expected:
            expected_identity = self._inventory_identities[key]
            try:
                with self._parent_for_key(key) as (descriptor, leaf):
                    metadata = os.stat(leaf, dir_fd=descriptor, follow_symlinks=False)
                    if (
                        not stat.S_ISREG(metadata.st_mode)
                        or self._identity(metadata) != expected_identity
                    ):
                        raise ValueError
                    os.unlink(leaf, dir_fd=descriptor)
            except FileNotFoundError:
                raise ResetError(
                    "Private storage cleanup plan changed; run a fresh dry run"
                ) from None
            except (OSError, ValueError):
                raise ResetError("Private storage cleanup is unavailable") from None
        if self.list_object_keys():
            raise ResetError(
                "Private storage cleanup is incomplete; run a fresh dry run before retrying"
            )

    def _walk(
        self, descriptor: int, parts: tuple[str, ...], identities: dict[str, tuple[int, int]]
    ) -> None:
        for name in os.listdir(descriptor):
            if name in {".", ".."}:
                continue
            metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISDIR(metadata.st_mode):
                child = self._open_directory_at(descriptor, name)
                try:
                    self._walk(child, (*parts, name), identities)
                finally:
                    os.close(child)
            elif stat.S_ISREG(metadata.st_mode):
                key = "/".join((*parts, name))
                if key in identities:
                    raise ValueError
                identities[key] = self._identity(metadata)
            else:
                raise ValueError

    @contextmanager
    def _location(self, name: str) -> Iterator[int]:
        self._assert_root_current()
        descriptor = self._open_directory_at(self._root_fd, name)
        try:
            yield descriptor
        finally:
            os.close(descriptor)

    @contextmanager
    def _parent_for_key(self, key: str) -> Iterator[tuple[int, str]]:
        parts = self._validate_key(key)
        descriptor = os.dup(self._root_fd)
        try:
            for name in parts[:-1]:
                child = self._open_directory_at(descriptor, name)
                os.close(descriptor)
                descriptor = child
            yield descriptor, parts[-1]
        finally:
            os.close(descriptor)

    def _assert_root_current(self) -> None:
        metadata = os.stat(self.root, follow_symlinks=False)
        if not stat.S_ISDIR(metadata.st_mode) or self._identity(metadata) != self._root_identity:
            raise ValueError

    @staticmethod
    def _open_directory_path(path: Path) -> int:
        return os.open(path, _READONLY | _NOFOLLOW)

    @staticmethod
    def _open_directory_at(parent: int, name: str) -> int:
        return os.open(name, _READONLY | _NOFOLLOW, dir_fd=parent)

    @staticmethod
    def _identity(metadata: os.stat_result) -> tuple[int, int]:
        return metadata.st_dev, metadata.st_ino

    def _validate_key(self, key: str) -> tuple[str, ...]:
        path = Path(key)
        if (
            not key
            or path.is_absolute()
            or len(path.parts) < 2
            or path.parts[0] not in self._LOCATIONS
            or any(part in {"", ".", ".."} for part in path.parts)
        ):
            raise ResetError("Private storage cleanup plan is invalid")
        return path.parts
