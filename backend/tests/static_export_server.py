"""Serve the static frontend export for browser tests (Tier 2.5 plan item 1).

Pages and assets go through ``app.core.static_site.StaticSite``, the production code, so the
browser sees production routing, cache headers, and CSP. ``/api/*`` answers 500, the same as
the development proxy with no backend: browser tests mock the API with ``page.route``.

From backend/:  uv run python -m tests.static_export_server --root ../frontend/out --port 3104
"""

from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse, Response
from starlette.routing import Route

from app.core.static_site import StaticSite

_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]


def create_app(root: Path) -> Starlette:
    site = StaticSite.load(root)

    async def handle(request: Request) -> Response:
        path = request.url.path
        if path == "/api" or path.startswith("/api/"):
            return PlainTextResponse("Internal Server Error", status_code=500)
        if request.method not in {"GET", "HEAD"}:
            return Response(status_code=405, headers={"Allow": "GET, HEAD"})
        return site.response_for(path)

    return Starlette(routes=[Route("/{path:path}", handle, methods=_METHODS)])


def main(arguments: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--port", type=int, required=True)
    options = parser.parse_args(arguments)
    uvicorn.run(create_app(options.root), host="127.0.0.1", port=options.port, log_level="warning")


if __name__ == "__main__":
    main()
