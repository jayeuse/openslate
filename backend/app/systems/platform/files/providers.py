"""Explicit private storage contract, provider errors, and file transfer capacity."""

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from threading import Condition, Lock
from time import monotonic
from types import TracebackType
from typing import Protocol

from fastapi import HTTPException, Request

from app.core.config import get_settings


class ProviderUnavailable(RuntimeError):
    def __init__(self, message: str = "", *, kind: str | None = None) -> None:
        super().__init__(message)
        # What failed (timeout, connect, http_<status>) for operational logs.
        self.kind = kind


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


_storage_cleanup_uncertain = False
# A caller that cannot retry (a job, or a save with no client retry) waits this long
# for capacity; a file transfer route refuses at once and its client retries.
PROCESSING_WAIT_SECONDS = 15.0
# A transfer request's body is already in memory and counted in the budget; it queues this
# long on the event loop for a processing slot before 503, instead of making the client send
# it again. Its dependencies (and their database session) start only once the slot is held.
SLOT_WAIT_SECONDS = 10.0
_SLOT_POLL_SECONDS = 0.02
_active_lease: ContextVar["TransferLease | None"] = ContextVar("file_transfer_lease", default=None)


def _busy() -> HTTPException:
    return HTTPException(
        503,
        detail={"code": "files_busy", "message": "File capacity is busy"},
        headers={"Retry-After": "1"},
    )


class FileCapacity:
    """One API process's file bytes in memory (budget) and file processing slots."""

    def __init__(self, budget_bytes: int, slots: int) -> None:
        self.budget_bytes, self.slots = budget_bytes, slots
        self.reserved = 0
        self.busy_slots = 0
        self._changed = Condition()

    def _fits(self, size: int, slot: bool) -> bool:
        return self.reserved + size <= self.budget_bytes and (
            not slot or self.busy_slots < self.slots
        )

    def acquire(self, size: int, *, slot: bool, wait_seconds: float = 0) -> None:
        """Reserve ``size`` bytes (and a slot), waiting at most ``wait_seconds``; else 503."""
        deadline = monotonic() + wait_seconds
        with self._changed:
            while True:
                if _storage_cleanup_uncertain:
                    raise _busy()
                if self._fits(size, slot):
                    # The fence can be raised while this thread is admitted; recheck it.
                    if _storage_cleanup_uncertain:
                        raise _busy()
                    self.reserved += size
                    self.busy_slots += int(slot)
                    return
                remaining = deadline - monotonic()
                if remaining <= 0:
                    raise _busy()
                self._changed.wait(remaining)

    def release(self, size: int, *, slot: bool) -> None:
        with self._changed:
            self.reserved -= size
            self.busy_slots -= int(slot)
            self._changed.notify_all()


_pool: FileCapacity | None = None
_pool_lock = Lock()


def capacity() -> FileCapacity:
    """The process-wide file capacity, sized once from settings."""
    global _pool
    with _pool_lock:
        if _pool is None:
            settings = get_settings()
            _pool = FileCapacity(
                settings.file_memory_budget_mib * 1024 * 1024, settings.file_processing_slots
            )
        return _pool


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
    """One request's budget reservation and processing slot; they survive cancellation.

    The body bytes and the slot return when the middleware, the dispatch, and every
    worker have released their references (the body has been processed). Downloaded
    bytes also wait until the response has been sent, because they are in memory until then.
    """

    def __init__(self, size: int = 0) -> None:
        self._pool = capacity()
        self._pool.acquire(size, slot=False)
        self._lock = Lock()
        self._references = 1
        self._middleware_open = True
        self._response_open = True
        self.body_bytes = size
        self._downloaded = 0
        self.holds_slot = False

    def take_slot(self) -> None:
        """Take a processing slot now, or refuse with 503."""
        with self._lock:
            if not self._middleware_open or self.holds_slot:
                raise _busy()
            self._pool.acquire(0, slot=True)
            self.holds_slot = True

    async def wait_for_slot(self, wait_seconds: float) -> None:
        """Wait on the event loop, up to ``wait_seconds``, for a processing slot."""
        deadline = asyncio.get_running_loop().time() + wait_seconds
        while True:
            try:
                return self.take_slot()
            except HTTPException:
                if _storage_cleanup_uncertain or asyncio.get_running_loop().time() >= deadline:
                    raise
            await asyncio.sleep(_SLOT_POLL_SECONDS)

    def retain_worker(self) -> WorkerLease:
        with self._lock:
            if not self._middleware_open:
                raise _busy()
            self._references += 1
            return WorkerLease(self)

    def shrink_body(self, size: int) -> None:
        """Return the part of the reservation the body did not use."""
        with self._lock:
            unused = self.body_bytes - size if self._references and size < self.body_bytes else 0
            self.body_bytes -= unused
        if unused:
            self._pool.release(unused, slot=False)

    def reserve_download(self, size: int) -> None:
        with self._lock:
            if not self._references:
                raise _busy()
            self._pool.acquire(size, slot=False)
            self._downloaded += size

    def _release_locked(self) -> None:
        self._references -= 1
        if self._references == 0:
            body, self.body_bytes = self.body_bytes, 0
            slot, self.holds_slot = self.holds_slot, False
            self._pool.release(body, slot=slot)
            if not self._response_open:
                self._release_downloaded_locked()

    def _release_downloaded_locked(self) -> None:
        downloaded, self._downloaded = self._downloaded, 0
        if downloaded:
            self._pool.release(downloaded, slot=False)

    def release_middleware(self) -> None:
        """The middleware is done with the body: the route returned, failed, or was cancelled."""
        with self._lock:
            if self._middleware_open:
                self._middleware_open = False
                self._release_locked()

    def close_response(self) -> None:
        """The response was sent or abandoned; a running worker still keeps its bytes."""
        with self._lock:
            if self._response_open:
                self._response_open = False
                if self._references == 0:
                    self._release_downloaded_locked()


@contextmanager
def transfer_admission(size: int = 0) -> Iterator[TransferLease]:
    """Admit one request's ``size`` body bytes and a slot, as the request middleware does."""
    lease = TransferLease(size)
    try:
        lease.take_slot()
        yield lease
    finally:
        lease.release_middleware()
        lease.close_response()


@contextmanager
def file_processing(size: int = 0, wait_seconds: float | None = None) -> Iterator[None]:
    """A caller outside a file transfer route: wait for ``size`` bytes and a slot, then run."""
    pool = capacity()
    wait = PROCESSING_WAIT_SECONDS if wait_seconds is None else wait_seconds
    pool.acquire(size, slot=True, wait_seconds=wait)
    try:
        yield
    finally:
        pool.release(size, slot=True)


@contextmanager
def hold_file_worker(request: Request) -> Iterator[None]:
    """Call inside the synchronous route, never a yielding dependency.

    It attaches the processing slot that the middleware already holds for this request; it
    never waits. The slot returns when the route has finished, before the response is sent.
    """
    lease = getattr(request.state, "file_transfer_lease", None)
    if not isinstance(lease, TransferLease) or not lease.holds_slot:
        raise _busy()
    with lease.retain_worker():
        token = _active_lease.set(lease)
        try:
            yield
        finally:
            _active_lease.reset(token)


def reserve_download(size: int) -> None:
    """Reserve ``size`` bytes about to be read from Storage for this request's response.

    Outside a file transfer route this does nothing; those callers reserve in
    ``file_processing``.
    """
    lease = _active_lease.get()
    if lease is not None:
        lease.reserve_download(size)
