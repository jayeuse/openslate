"""Exact Host validation that preserves IPv6 loopback support."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send


class ExactTrustedHostMiddleware:
    """Reject Host headers outside the configured public origin and loopback hosts."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        allowed_hosts: Iterable[str],
        read_only_host_paths: Mapping[str, Iterable[str]] | None = None,
    ) -> None:
        self.app = app
        self.allowed_hosts = frozenset(host.lower() for host in allowed_hosts)
        self.read_only_host_paths = {
            host.lower(): frozenset(paths)
            for host, paths in (read_only_host_paths or {}).items()
        }

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        host = _host(scope)
        public_read = (
            scope["type"] == "http"
            and scope.get("method") == "GET"
            and scope.get("path") in self.read_only_host_paths.get(host or "", ())
        )
        if host in self.allowed_hosts or public_read:
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
