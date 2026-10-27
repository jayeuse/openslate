"""Bound only known binary file requests; retain ordinary JSON limits."""

import re
from collections.abc import Callable
from dataclasses import dataclass

from fastapi import HTTPException
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

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
        with dispatch:
            await self.app(scope, receive, send)


def backup_export_body_limit(path: str, method: str) -> int | None:
    if method == "POST" and (
        path == "/api/backups/exports"
        or re.fullmatch(r"/api/backups/exports/[^/]+/download-admission", path)
    ):
        return 1024
    return None
