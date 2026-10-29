"""Bound only known binary file requests; retain ordinary JSON limits."""

import re
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import HTTPException, Request
from starlette.datastructures import Headers
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.systems.platform.files import providers
from app.systems.platform.files.providers import TransferLease


@dataclass(frozen=True)
class FileTransferPolicy:
    request_bytes: int
    deadline_seconds: float


_UUID = (
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
_FILE_ROUTE = re.compile(rf"/api/files/{_UUID}/(content|reconcile|purge)")
_BOARD_FILE_ROUTE = re.compile(rf"/api/boards/{_UUID}/files/{_UUID}/(content|reconcile|purge)")
_COMMS_FILE_ROUTE = re.compile(rf"/api/comms/conversations/{_UUID}/files/{_UUID}/content")
_COMMS_PURGE_ROUTE = re.compile(rf"/api/comms/conversations/{_UUID}/purge")
_COMMS_EXPORT_ROUTE = re.compile(rf"/api/comms/exports/{_UUID}/content")
_BOARD_CONTENT_ROUTE = re.compile(
    rf"/api/boards/{_UUID}/(?:events|posts|cards)/{_UUID}/attachments/{_UUID}/content"
)


def file_transfer_policy(path: str, method: str) -> FileTransferPolicy | None:
    if method == "GET" and _COMMS_EXPORT_ROUTE.fullmatch(path):
        return FileTransferPolicy(1024 * 1024, 120)
    if method == "POST" and _COMMS_PURGE_ROUTE.fullmatch(path):
        return FileTransferPolicy(1024 * 1024, 120)
    if method in {"GET", "PUT"} and _COMMS_FILE_ROUTE.fullmatch(path):
        return FileTransferPolicy(10 * 1024 * 1024 if method == "PUT" else 1024 * 1024, 120)
    if path == "/api/workspace/logo" and method == "GET":
        return FileTransferPolicy(1024 * 1024, 120)
    if method == "GET" and _BOARD_CONTENT_ROUTE.fullmatch(path):
        return FileTransferPolicy(1024 * 1024, 120)
    board_match = _BOARD_FILE_ROUTE.fullmatch(path)
    match = board_match or _FILE_ROUTE.fullmatch(path)
    if match is None:
        return None
    action = match.group(1)
    if board_match and action == "content" and method != "PUT":
        return None
    if action == "content" and method in {"PUT", "GET"}:
        return FileTransferPolicy(10 * 1024 * 1024 if method == "PUT" else 1024 * 1024, 120)
    if action in {"reconcile", "purge"} and method == "POST":
        return FileTransferPolicy(1024 * 1024, 120)
    return None


def admit_request(headers: Headers, limit: int) -> TransferLease:
    """Reserve the declared body size before reading it; a chunked body reserves the limit.

    With neither header HTTP/1.1 has no body; one that arrives anyway exceeds the
    zero reservation and is refused with 413.
    """
    declared = headers.get("content-length")
    if declared is None:
        size = limit if "transfer-encoding" in headers else 0
    else:
        try:
            size = int(declared)
        except ValueError:
            size = limit
    return TransferLease(min(max(size, 0), limit))


async def read_bounded_body(request: Request, limit: int) -> bool:
    """Cache only an in-limit body so the downstream request can read it once."""

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            return False
        chunks.append(chunk)
    request._body = b"".join(chunks)  # noqa: SLF001 - Starlette middleware cache contract.
    lease = getattr(request.state, "file_transfer_lease", None)
    if isinstance(lease, TransferLease):
        lease.shrink_body(total)
    return True


async def wait_for_processing_slot(request: Request) -> None:
    """After the body is counted, queue for a slot before any dependency or route runs."""
    lease = getattr(request.state, "file_transfer_lease", None)
    if isinstance(lease, TransferLease):
        await lease.wait_for_slot(providers.SLOT_WAIT_SECONDS)


def release_request_body(request: Request) -> None:
    """The route has returned: drop the cached body and its reservation before sending."""
    lease = getattr(request.state, "file_transfer_lease", None)
    if isinstance(lease, TransferLease):
        request._body = b""  # noqa: SLF001 - Starlette middleware cache contract.
        lease.release_middleware()


class CapacityResponse(Response):
    """Own admission through response start, body delivery, and disconnects."""

    def __init__(self, response: Response, release: Callable[[], None]) -> None:
        super().__init__(status_code=response.status_code)
        self.raw_headers = response.raw_headers
        self._response = response
        self._release = release

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await self._response(scope, receive, send)
        finally:
            self._release()


class FileDispatchMiddleware:
    """Retain admission while downstream parsing and dependencies still own the request."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        lease = scope.get("state", {}).get("file_transfer_lease")
        if scope["type"] != "http" or not isinstance(lease, TransferLease):
            await self.app(scope, receive, send)
            return
        try:
            dispatch = lease.retain_worker()
        except HTTPException as error:
            await JSONResponse(status_code=error.status_code, content={"detail": error.detail})(
                scope, receive, send
            )
            return

        async def send_and_release(message: Message) -> None:
            # The route has returned once its response starts; a slow reader holds nothing.
            if message["type"] == "http.response.start":
                dispatch.release()
            await send(message)

        with dispatch:
            await self.app(scope, receive, send_and_release)


def backup_export_body_limit(path: str, method: str) -> int | None:
    if method == "POST" and (
        path == "/api/backups/exports"
        or re.fullmatch(r"/api/backups/exports/[^/]+/download-admission", path)
    ):
        return 1024
    return None
