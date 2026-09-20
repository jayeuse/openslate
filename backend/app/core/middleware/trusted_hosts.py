"""Exact Host validation that preserves IPv6 loopback support."""

from __future__ import annotations

from collections.abc import Iterable
from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class ExactTrustedHostMiddleware:
    """Reject Host headers outside the configured public origin and loopback hosts."""

    def __init__(self, app: ASGIApp, *, allowed_hosts: Iterable[str]) -> None:
        self.app = app
        self.allowed_hosts = frozenset(host.lower() for host in allowed_hosts)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"} or _host(scope) in self.allowed_hosts:
            await self.app(scope, receive, send)
            return
        await PlainTextResponse("Invalid host header", status_code=400)(scope, receive, send)


def _host(scope: Scope) -> str | None:
    value = Headers(scope=scope).get("host")
    if value is None:
        return None
    parsed = urlsplit(f"//{value}")
    if parsed.username is not None or parsed.password is not None or parsed.hostname is None:
        return None
    try:
        _port = parsed.port
    except ValueError:
        return None
    return parsed.hostname.lower()
