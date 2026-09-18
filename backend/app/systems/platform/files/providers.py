"""Explicit provider contracts. Missing scanning never produces a clean result."""

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from threading import BoundedSemaphore, Lock
from types import TracebackType
from typing import Literal, Protocol
from uuid import UUID

from fastapi import HTTPException, Request

from app.core.config import ConfigurationError, get_scanner_settings


class ProviderUnavailable(RuntimeError):
    pass


class StorageCleanupUncertain(ProviderUnavailable):
    """A download child may remain alive; stop this runtime before replacement."""


class ProviderRejected(ProviderUnavailable):
    """Provider definitively rejected this request before accepting bytes."""


class ScannerExecutionUncertain(ProviderUnavailable):
    """The engine may still be executing; fence scans until operator replacement."""


class ScannerPolicyRejected(ProviderUnavailable):
    """The engine definitively rejected inspection under its resource policy."""


@dataclass(frozen=True)
class ScanVerdict:
    outcome: Literal["clean", "infected", "unknown"]
    digest: str
    scanner_version: str
    signature_version: str


class Scanner(Protocol):
    def probe(self) -> None:
        """Check fixed engine readiness without submitting file bytes."""
        ...

    def scan(self, content: bytes, *, digest: str, operation_id: UUID) -> ScanVerdict:
        """Return a verdict on exactly these bytes within 60 seconds."""
        ...


class UnavailableScanner:
    def probe(self) -> None:
        raise ProviderUnavailable("Scanner is not configured")

    def scan(self, content: bytes, *, digest: str, operation_id: UUID) -> ScanVerdict:
        raise ProviderUnavailable("Scanner is not configured")


def get_scanner(*, require_configuration: bool = False) -> Scanner:
    from app.systems.platform.files.clamav import ClamAVScanner

    try:
        settings = get_scanner_settings()
    except ConfigurationError:
        if require_configuration:
            raise
        return UnavailableScanner()
    return ClamAVScanner(
        settings.files_clamav_host,
        settings.files_clamav_port,
        settings.files_clamav_manifest_path,
    )


class Storage(Protocol):
    def upload(self, key: str, content: bytes, media_type: str) -> None: ...
    def download(self, key: str) -> bytes | None: ...
    def delete(self, key: str) -> None: ...


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

    def __init__(self) -> None:
        if _storage_cleanup_uncertain:
            raise _busy()
        if not _slots.acquire(blocking=False):
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
def transfer_slot() -> Iterator[TransferLease]:
    lease = TransferLease()
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
