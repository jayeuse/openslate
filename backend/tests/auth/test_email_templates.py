import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.systems.access.auth.template_router import router


def test_supabase_can_fetch_raw_templates_without_consuming_email_actions() -> None:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    with TestClient(app) as client:
        for name, page in (
            ("invite", "setup"),
            ("recovery", "recovery"),
            ("email-change", "email-change"),
        ):
            response = client.get(f"/api/auth/email-templates/{name}.html")
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/html")
            assert "{{ .TokenHash }}" in response.text
            assert f"{{{{ .SiteURL }}}}/auth/{page}#token_hash=" in response.text


def test_template_endpoint_cannot_read_arbitrary_installation_files() -> None:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    with TestClient(app) as client:
        response = client.get("/api/auth/email-templates/.env")
        assert response.status_code == 404


@pytest.mark.parametrize("host", ["api", "host.docker.internal"])
def test_internal_provider_host_can_only_fetch_public_templates(host: str) -> None:
    from app.main import create_app

    client = TestClient(create_app(), base_url=f"http://{host}:8000")
    try:
        for name in ("invite", "recovery", "email-change"):
            response = client.get(f"/api/auth/email-templates/{name}.html")
            assert response.status_code == 200
            assert "{{ .TokenHash }}" in response.text
        assert client.get("/api/auth/session").status_code == 400
        assert client.get("/api/auth/email-templates/.env").status_code == 400
        assert client.post("/api/auth/email-templates/invite.html").status_code == 400
        assert (
            client.get(
                "/api/auth/email-templates/invite.html", headers={"Host": "unknown.example"}
            ).status_code
            == 400
        )
    finally:
        client.close()
