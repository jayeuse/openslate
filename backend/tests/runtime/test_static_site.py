from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.main as main
from app.core.config import ConfigurationError, Settings
from tests.config_support import settings_values


def _write_export(root: Path) -> None:
    (root / "_next" / "static").mkdir(parents=True)
    (root / "_next" / "static" / "app-123.js").write_text("export {};", encoding="utf-8")
    document = (
        "<!doctype html><html><head><style>.page{color:red}</style>"
        "<script>window.openslateBoot=true;</script>"
        '<script src="/_next/static/app-123.js"></script></head>'
        '<body><main class="page">OpenSlate</main></body></html>'
    )
    (root / "index.html").write_text(document, encoding="utf-8")
    (root / "sandbox.html").write_text(document.replace("OpenSlate", "Sandbox"), encoding="utf-8")
    (root / "_not-found.html").write_text(
        document.replace("OpenSlate", "Internal Next route"), encoding="utf-8"
    )
    (root / "404.html").write_text("<html><body>Missing</body></html>", encoding="utf-8")
    (root / "favicon.ico").write_bytes(b"ico")


def _static_client(
    monkeypatch: pytest.MonkeyPatch, root: Path, *, environment: str = "test"
) -> TestClient:
    settings = Settings(
        **settings_values(environment=environment, web_assets_root=root), _env_file=None
    )
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    return TestClient(main.create_app())


def test_static_site_serves_only_known_html_and_exact_files(monkeypatch, tmp_path: Path) -> None:
    _write_export(tmp_path)
    client = _static_client(monkeypatch, tmp_path)

    home = client.get("/")
    sandbox = client.get("/sandbox")
    asset = client.get("/_next/static/app-123.js")
    missing_asset = client.get("/_next/static/missing.js")
    missing = client.get("/unknown")
    api_prefix_neighbor = client.get("/apiary")
    internal = client.get("/_not-found")
    api_missing = client.get("/api/unknown")
    head = client.head("/")
    post = client.post("/sandbox")

    assert home.status_code == 200 and home.text.endswith("</html>")
    assert sandbox.status_code == 200 and "Sandbox" in sandbox.text
    assert asset.status_code == 200 and asset.text == "export {};"
    assert missing_asset.status_code == 404
    assert not missing_asset.headers["Content-Type"].startswith("text/html")
    assert "Missing" not in missing_asset.text
    assert missing.status_code == 404 and "Missing" in missing.text
    assert api_prefix_neighbor.status_code == 404 and "Missing" in api_prefix_neighbor.text
    assert internal.status_code == 404 and "Missing" in internal.text
    assert api_missing.status_code == 404 and api_missing.json() == {"detail": "Not Found"}
    assert head.status_code == 200 and head.content == b""
    assert post.status_code == 405
    assert client.get("/", headers={"Host": "untrusted.example.test"}).status_code == 400
    assert client.get("/", headers={"Host": "[::1]"}).status_code == 200


def test_static_site_sets_csp_security_and_cache_headers(monkeypatch, tmp_path: Path) -> None:
    _write_export(tmp_path)
    client = _static_client(monkeypatch, tmp_path)

    page = client.get("/")
    asset = client.get("/_next/static/app-123.js")
    api = client.get("/api/health")
    denied_events = client.get("/api/events")

    assert "script-src 'self' 'sha256-" in page.headers["Content-Security-Policy"]
    assert "style-src-elem 'self' 'sha256-" in page.headers["Content-Security-Policy"]
    assert "nonce-" not in page.headers["Content-Security-Policy"]
    assert page.headers["Cache-Control"] == "no-cache, must-revalidate"
    assert asset.headers["Cache-Control"] == "public, max-age=31536000, immutable"
    assert api.headers["Cache-Control"] == "no-store"
    assert denied_events.status_code == 401
    assert denied_events.headers["Cache-Control"] == "no-store"
    assert page.headers["X-Content-Type-Options"] == "nosniff"
    assert page.headers["X-Frame-Options"] == "DENY"
    assert page.headers["Permissions-Policy"].endswith("payment=()")
    assert "Access-Control-Allow-Origin" not in api.headers


def test_static_site_denies_path_escape_and_symlink_escape(monkeypatch, tmp_path: Path) -> None:
    _write_export(tmp_path)
    outside = tmp_path.parent / "outside.js"
    outside.write_text("private", encoding="utf-8")
    os.symlink(outside, tmp_path / "escape.js")
    client = _static_client(monkeypatch, tmp_path)

    assert client.get("/%2e%2e/outside.js").status_code == 404
    assert client.get("/escape.js").status_code == 404


def test_static_site_configuration_requires_assets_outside_development_and_test(
    tmp_path: Path,
) -> None:
    with pytest.raises(ValidationError, match="WEB_ASSETS_ROOT"):
        Settings(
            **settings_values(
                environment="production", public_origin="https://app.example.test"
            ),
            _env_file=None,
        )

    settings = Settings(
        **settings_values(
            environment="production",
            public_origin="https://app.example.test",
            web_assets_root=tmp_path,
        ),
        _env_file=None,
    )
    original = main.get_settings
    main.get_settings = lambda: settings
    try:
        with pytest.raises(ConfigurationError, match="Static site"):
            main.create_app()
    finally:
        main.get_settings = original


def test_documentation_is_only_exposed_under_api_in_development_and_test(
    monkeypatch, tmp_path: Path
) -> None:
    _write_export(tmp_path)
    test_app = _static_client(monkeypatch, tmp_path).app
    assert test_app.docs_url == "/api/docs"
    assert test_app.redoc_url is None
    assert test_app.openapi_url == "/api/openapi.json"

    production = Settings(
        **settings_values(
            environment="production",
            public_origin="https://app.example.test",
            web_assets_root=tmp_path,
        ),
        _env_file=None,
    )
    monkeypatch.setattr(main, "get_settings", lambda: production)
    production_app = main.create_app()
    assert production_app.docs_url is None
    assert production_app.openapi_url is None

    test_client = TestClient(test_app)
    docs = test_client.get("/api/docs")
    assert docs.status_code == 200
    assert "Content-Security-Policy" not in docs.headers
    assert "https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/" in docs.text
    assert test_client.get("/openapi.json").status_code == 404
