"""Explicit private storage contract, provider errors, and transfer slots."""

from collections.abc import Iterator
from contextlib import contextmanager
from threading import BoundedSemaphore, Lock
from types import TracebackType
from typing import Protocol

from fastapi import HTTPException, Request


class ProviderUnavailable(RuntimeError):
    pass


class StorageCleanupUncertain(ProviderUnavailable):
    """A download child may remain alive; stop this runtime before replacement."""


class ProviderRejected(ProviderUnavailable):
    """Provider definitively rejected this request before accepting bytes."""


class ProviderWriteRejected(ProviderRejected):
    """Local storage definitively failed before installing an immutable object."""


class StorageBackend(Protocol):
    """Private immutable bytes, read only through FastAPI after authorization."""

    def upload(self, key: str, content: bytes, media_type: str) -> None:
        """Create a new immutable private object."""
        ...

    def download(self, key: str) -> bytes | None:
        """Read an object, or return None when it does not exist."""
        ...

    def delete(self, key: str) -> None:
        """Idempotently remove an object."""
        ...


# Compatibility for consumers outside this feature while the storage migration
# is integrated. New storage code must use the explicit StorageBackend name.
Storage = StorageBackend


_slots = BoundedSemaphore(2)
_storage_cleanup_uncertain = False


def _busy() -> HTTPException:
    return HTTPException(503, detail={"code": "files_busy", "message": "File capacity is busy"})


class WorkerLease:
    """An idempotently releasable reference held by the actual synchronous worker."""

    def __init__(self, parent: "TransferLease") -> None:
        self._parent = parent
        self._released = False

    def __enter__(self) -> "WorkerLease":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.release()

    def release(self) -> None:
        with self._parent._lock:
            if not self._released:
                self._released = True
                self._parent._release_locked()


class TransferLease:
    """One physical slot survives response cancellation until all workers release it."""

    def __init__(self, wait_seconds: float = 0) -> None:
        if _storage_cleanup_uncertain:
            raise _busy()
        if not (
            _slots.acquire(timeout=wait_seconds) if wait_seconds else _slots.acquire(blocking=False)
        ):
            raise _busy()
        if _storage_cleanup_uncertain:
            _slots.release()
            raise _busy()
        self._lock = Lock()
        self._references = 1
        self._middleware_open = True

    def retain_worker(self) -> WorkerLease:
        with self._lock:
            if not self._middleware_open:
                raise _busy()
            self._references += 1
            return WorkerLease(self)

    def _release_locked(self) -> None:
        self._references -= 1
        if self._references == 0:
            _slots.release()

    def release_middleware(self) -> None:
        with self._lock:
            if self._middleware_open:
                self._middleware_open = False
                self._release_locked()


@contextmanager
def transfer_slot(wait_seconds: float = 0) -> Iterator[TransferLease]:
    """Admit one transfer; with ``wait_seconds``, wait that long for a slot before refusing."""
    lease = TransferLease(wait_seconds)
    try:
        yield lease
    finally:
        lease.release_middleware()


@contextmanager
def hold_file_worker(request: Request) -> Iterator[None]:
    """Call inside the synchronous route, never a yielding dependency."""
    lease = getattr(request.state, "file_transfer_lease", None)
    if not isinstance(lease, TransferLease):
        raise _busy()
    with lease.retain_worker():
        yield
