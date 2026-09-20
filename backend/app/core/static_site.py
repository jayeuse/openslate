"""Serve a verified static frontend export from the FastAPI application."""

from __future__ import annotations

import base64
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Final

from starlette.responses import FileResponse, Response

from app.core.config.environment import ConfigurationError

_INLINE_TAG: Final = re.compile(
    rb"<(?P<tag>script|style)\b(?P<attributes>[^>]*)>(?P<body>.*?)</(?P=tag)\s*>",
    re.IGNORECASE | re.DOTALL,
)
_EXTERNAL_SCRIPT: Final = re.compile(rb"(?:^|\s)src\s*=", re.IGNORECASE)
_EVENT_HANDLER: Final = re.compile(rb"<[^>]+\son[a-z][a-z0-9_-]*\s*=", re.IGNORECASE)
_STATIC_CSP: Final = (
    "default-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; "
    "worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'self'; "
    "form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests"
)


@dataclass(frozen=True, slots=True)
class StaticDocument:
    content: bytes
    csp: str


@dataclass(frozen=True, slots=True)
class StaticSite:
    """An immutable, startup-validated index of one Next static export."""

    root: Path
    pages: dict[str, StaticDocument]
    not_found: StaticDocument

    @classmethod
    def load(cls, configured_root: Path) -> StaticSite:
        try:
            root = configured_root.resolve(strict=True)
        except OSError as error:
            raise ConfigurationError("Static site assets are unavailable") from error
        if not root.is_dir():
            raise ConfigurationError("Static site assets are unavailable")

        pages: dict[str, StaticDocument] = {}
        not_found: StaticDocument | None = None
        for candidate in root.rglob("*.html"):
            resolved = _resolve_under_root(root, candidate)
            if resolved is None:
                raise ConfigurationError("Static site contains an unsafe HTML path")
            document = _load_document(resolved)
            relative = resolved.relative_to(root)
            if relative == Path("404.html"):
                not_found = document
                continue
            if any(part.startswith("_") for part in relative.parts):
                continue
            pages[_route_for_export(relative)] = document
        if "/" not in pages or not_found is None:
            raise ConfigurationError("Static site assets require index.html and 404.html")
        return cls(root=root, pages=pages, not_found=not_found)

    def response_for(self, path: str) -> Response:
        page = self.pages.get(path)
        if page is not None:
            return _document_response(page, status_code=200)
        asset = self._asset_for(path)
        if asset is not None:
            return asset
        if path.startswith("/_next/") or PurePosixPath(path).suffix:
            return Response(
                content="Not Found",
                status_code=404,
                media_type="text/plain",
                headers={"Cache-Control": "no-store"},
            )
        return _document_response(self.not_found, status_code=404)

    def _asset_for(self, path: str) -> FileResponse | None:
        relative = path.lstrip("/")
        if not relative or relative.endswith("/") or relative.endswith(".html"):
            return None
        candidate = self.root.joinpath(*relative.split("/"))
        resolved = _resolve_under_root(self.root, candidate)
        if resolved is None or not resolved.is_file():
            return None
        return FileResponse(resolved, headers={"Cache-Control": _cache_control(path)})


def _route_for_export(relative: Path) -> str:
    if relative.name == "index.html":
        parent = relative.parent.as_posix()
        return "/" if parent == "." else f"/{parent}/"
    return f"/{relative.with_suffix('').as_posix()}"


def _resolve_under_root(root: Path, candidate: Path) -> Path | None:
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        return None
    try:
        resolved.relative_to(root)
    except ValueError:
        return None
    return resolved


def _load_document(path: Path) -> StaticDocument:
    try:
        content = path.read_bytes()
    except OSError as error:
        raise ConfigurationError("Static site assets are unavailable") from error
    if _EVENT_HANDLER.search(content):
        raise ConfigurationError("Static site contains unsupported inline event handlers")
    script_hashes: list[str] = []
    style_hashes: list[str] = []
    for match in _INLINE_TAG.finditer(content):
        if match.group("tag").lower() == b"script" and _EXTERNAL_SCRIPT.search(
            match.group("attributes")
        ):
            continue
        digest = _csp_hash(match.group("body"))
        if match.group("tag").lower() == b"script":
            script_hashes.append(digest)
        else:
            style_hashes.append(digest)
    return StaticDocument(content=content, csp=_document_csp(script_hashes, style_hashes))


def _csp_hash(content: bytes) -> str:
    encoded = base64.b64encode(hashlib.sha256(content).digest()).decode("ascii")
    return f"'sha256-{encoded}'"


def _document_csp(script_hashes: list[str], style_hashes: list[str]) -> str:
    script_sources = " ".join(("'self'", *script_hashes))
    style_sources = " ".join(("'self'", *style_hashes))
    directives = (
        f"script-src {script_sources}",
        f"style-src-elem {style_sources}",
        "style-src-attr 'unsafe-inline'",
        _STATIC_CSP,
    )
    return "; ".join(directives)


def _document_response(document: StaticDocument, *, status_code: int) -> Response:
    return Response(
        content=document.content,
        status_code=status_code,
        media_type="text/html",
        headers={
            "Cache-Control": "no-cache, must-revalidate",
            "Content-Security-Policy": document.csp,
        },
    )


def _cache_control(path: str) -> str:
    if path.startswith("/_next/static/"):
        return "public, max-age=31536000, immutable"
    return "no-cache, must-revalidate"
