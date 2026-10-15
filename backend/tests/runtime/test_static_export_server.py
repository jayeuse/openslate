from pathlib import Path

from starlette.testclient import TestClient

from tests.static_export_server import create_app


def _export(root: Path) -> Path:
    (root / "_next/static").mkdir(parents=True)
    (root / "index.html").write_text("<html><body>home</body></html>")
    (root / "404.html").write_text("<html><body>missing</body></html>")
    (root / "openview.html").write_text("<html><script>boot()</script>views</html>")
    (root / "_next/static/app.js").write_text("console.log(1)")
    return root


def test_pages_use_production_routing_and_csp(tmp_path):
    client = TestClient(create_app(_export(tmp_path)))

    page = client.get("/openview?section=views")
    assert page.status_code == 200
    assert page.text == "<html><script>boot()</script>views</html>"
    assert "script-src 'self' 'sha256-" in page.headers["content-security-policy"]

    asset = client.get("/_next/static/app.js")
    assert asset.status_code == 200
    assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"

    missing = client.get("/retired-route")
    assert missing.status_code == 404
    assert missing.text == "<html><body>missing</body></html>"


def test_unmocked_api_requests_fail_like_the_development_proxy(tmp_path):
    client = TestClient(create_app(_export(tmp_path)))

    for method in ("get", "post"):
        response = getattr(client, method)("/api/workspace")
        assert response.status_code == 500
        assert response.text == "Internal Server Error"


def test_page_writes_are_refused(tmp_path):
    client = TestClient(create_app(_export(tmp_path)))

    response = client.post("/openview")
    assert response.status_code == 405
    assert response.headers["allow"] == "GET, HEAD"
