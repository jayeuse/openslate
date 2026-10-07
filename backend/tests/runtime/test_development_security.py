from ipaddress import ip_address, ip_network
from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.orm import Session
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

import app.common.dependencies.auth as auth_dependencies
import app.main as main
from app import __main__ as entrypoint
from app.core.config import Settings
from app.core.config.development import browser_origin_is_permitted, is_relaxed_development
from app.core.integrations.supabase_auth import InvalidProviderCredentials
from app.systems.access.identity import rate_limits
from app.systems.access.identity.contracts import InvalidCredentials
from app.systems.access.identity.provider_login import login_with_provider
from app.systems.access.identity.rate_limits import invitation_completion_permitted
from app.systems.manage.audit.models import SecurityEvent, SecurityEventOutcome
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.config_support import settings_values


def _development_settings(**overrides: object) -> Settings:
    public_origin = str(overrides.get("public_origin", "http://127.0.0.1:3000"))
    values = settings_values(
        environment="development",
        public_origin=public_origin,
        backend_bind_host="127.0.0.1",
    )
    values.update(overrides)
    return Settings(**values, _env_file=None)


@pytest.mark.parametrize(
    "origin",
    [
        None,
        "http://localhost:3000",
        "https://127.0.0.1:4443",
        "http://192.168.1.20:3000",
        "http://169.254.10.20:3000",
        "http://[fe80::1]:3000",
    ],
)
def test_loopback_development_accepts_missing_and_local_browser_origins(origin: str | None) -> None:
    assert browser_origin_is_permitted(_development_settings(), origin)


@pytest.mark.parametrize(
    "origin",
    [
        "https://example.test",
        "http://8.8.8.8:3000",
        "http://0.0.0.0:3000",
        "http://192.0.2.1:3000",
        "http://224.0.0.1:3000",
        "http://[::]:3000",
        "ftp://localhost:3000",
        "null",
    ],
)
def test_loopback_development_rejects_non_local_or_malformed_browser_origins(origin: str) -> None:
    assert not browser_origin_is_permitted(_development_settings(), origin)


def test_test_and_non_loopback_development_retain_exact_browser_origin_requirement() -> None:
    test_settings = Settings(**settings_values(), _env_file=None)
    non_loopback_development = _development_settings(
        backend_bind_host="0.0.0.0", public_origin="https://app.example.test"
    )

    assert not is_relaxed_development(test_settings)
    assert not is_relaxed_development(non_loopback_development)
    assert browser_origin_is_permitted(test_settings, test_settings.public_origin)
    assert not browser_origin_is_permitted(test_settings, None)
    assert not browser_origin_is_permitted(test_settings, "http://localhost:3000")
    assert browser_origin_is_permitted(
        non_loopback_development, non_loopback_development.public_origin
    )
    assert not browser_origin_is_permitted(non_loopback_development, None)


@pytest.mark.parametrize("public_origin", ["http://192.168.1.20:3000", "http://169.254.10.20"])
def test_loopback_development_allows_private_and_link_local_http_public_origins(
    public_origin: str,
) -> None:
    assert _development_settings(public_origin=public_origin).public_origin == public_origin


def test_loopback_development_keeps_provider_issuer_independent_from_browser_origin() -> None:
    settings = _development_settings(
        public_origin="http://localhost:3000/",
        supabase_auth_issuer="http://127.0.0.1:8000/auth/v1",
    )
    assert settings.public_origin == "http://localhost:3000"
    assert settings.supabase_auth_issuer == "http://127.0.0.1:8000/auth/v1"


def test_loopback_development_omits_generic_security_headers_and_trusted_host_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main, "get_settings", _development_settings)

    response = TestClient(main.create_app()).get(
        "/api/health", headers={"Host": "untrusted.example.test"}
    )

    assert response.status_code == 200
    assert "X-Content-Type-Options" not in response.headers
    assert "X-Frame-Options" not in response.headers


def test_loopback_development_allows_generic_request_bodies_over_the_configured_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(main, "get_settings", _development_settings)
    app = main.create_app()

    @app.post("/api/test-development-body")
    async def test_development_body(request: Request) -> dict[str, int]:
        return {"size": len(await request.body())}

    payload = b"x" * (_development_settings().request_body_max_bytes + 1)
    response = TestClient(app).post("/api/test-development-body", content=payload)

    assert response.status_code == 200
    assert response.json() == {"size": len(payload)}


def test_loopback_development_skips_anonymous_identity_rate_limit_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    scalar_rows = {
        WorkspaceProfile: WorkspaceProfile(session_timeout_minutes=60),
        SecurityEvent.id: None,
    }
    db.scalar.side_effect = lambda query: scalar_rows[query.column_descriptions[0]["expr"]]
    cleanup = Mock()
    lock = Mock()
    record = Mock()
    monkeypatch.setattr(rate_limits, "cleanup_expired_buckets", cleanup)
    monkeypatch.setattr(rate_limits, "lock_bucket", lock)
    monkeypatch.setattr(rate_limits, "record_attempt", record)
    provider = Mock()
    provider.password_grant.side_effect = InvalidProviderCredentials("invalid")

    with pytest.raises(InvalidCredentials, match="Invalid credentials"):
        login_with_provider(
            db, "unknown@example.test", "wrong password", provider, enforce_rate_limit=False
        )

    assert invitation_completion_permitted(db, source="127.0.0.1", enforce_rate_limit=False)
    cleanup.assert_not_called()
    lock.assert_not_called()
    record.assert_not_called()
    db.add.assert_called_once()
    event = db.add.call_args.args[0]
    assert isinstance(event, SecurityEvent)
    assert event.event_type == "identity.sign_in_failure"
    assert event.outcome is SecurityEventOutcome.FAILURE
    assert event.source == "identity.login"
    assert event.reason == "credentials_rejected"
    assert event.actor_id is None and event.subject_id is None


def test_loopback_development_cookie_mutations_still_require_csrf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.get.return_value = object()
    request = Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/test-cookie-mutation",
            "headers": [],
        }
    )
    monkeypatch.setattr(auth_dependencies, "get_settings", _development_settings)
    monkeypatch.setattr(auth_dependencies, "validate_csrf", lambda *_args: False)

    with pytest.raises(HTTPException) as denied:
        auth_dependencies._validate_cookie_mutation(request, db, uuid4())

    assert denied.value.status_code == 401


def test_loopback_development_omits_uvicorn_concurrency_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run = Mock()
    monkeypatch.setattr(entrypoint, "get_settings", _development_settings)
    monkeypatch.setattr(entrypoint.uvicorn, "run", run)

    entrypoint.main([])

    assert run.call_args.kwargs["limit_concurrency"] is None


@pytest.mark.parametrize(
    ("environment", "bind_host", "subnet", "expected"),
    [
        ("development", "127.0.0.1", None, ["127.0.0.1", "::1"]),
        ("development", "::1", "172.31.248.0/28", ["127.0.0.1", "::1"]),
        ("development", "0.0.0.0", "172.31.248.0/28", []),
        ("test", "127.0.0.1", "172.31.248.0/28", []),
        ("production", "0.0.0.0", "172.31.248.0/28", ["172.31.248.0/28"]),
        ("production", "0.0.0.0", None, []),
    ],
)
def test_entrypoint_explicitly_bounds_forwarded_peer_trust(
    monkeypatch: pytest.MonkeyPatch,
    environment: str,
    bind_host: str,
    subnet: str | None,
    expected: list[str],
) -> None:
    settings = Settings(
        **settings_values(
            environment=environment,
            backend_bind_host=bind_host,
            public_origin="https://app.example.test",
            web_assets_root="/tmp/openslate-static",
            open_slate_app_private_subnet=subnet,
        ),
        _env_file=None,
    )
    run = Mock()
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", "*")
    monkeypatch.setattr(entrypoint, "get_settings", lambda: settings)
    monkeypatch.setattr(entrypoint.uvicorn, "run", run)

    entrypoint.main([])

    assert run.call_args.kwargs["forwarded_allow_ips"] == expected


@pytest.mark.parametrize(
    "subnet",
    ["*", "0.0.0.0/0", "8.8.8.0/24", "127.0.0.0/8", "172.31.248.1/28", "172.31.248.0"],
)
def test_proxy_subnet_rejects_wildcard_public_and_non_network_values(subnet: str) -> None:
    with pytest.raises(ValidationError):
        Settings(**settings_values(open_slate_app_private_subnet=subnet), _env_file=None)


@pytest.mark.parametrize("subnet", ["172.31.248.0/28", "fd00:1234::/64"])
def test_proxy_subnet_is_a_typed_private_network(subnet: str) -> None:
    settings = Settings(**settings_values(open_slate_app_private_subnet=subnet), _env_file=None)

    assert settings.open_slate_app_private_subnet == ip_network(subnet)


@pytest.mark.parametrize(
    ("peer", "forwarded", "expected"),
    [
        ("10.0.0.10", "203.0.113.20", "10.0.0.10"),
        ("127.0.0.1", "203.0.113.20", "127.0.0.1"),
        ("172.31.248.2", "203.0.113.20", "203.0.113.20"),
        ("172.31.248.2", "203.0.113.20, 198.51.100.4", "198.51.100.4"),
    ],
)
def test_real_proxy_middleware_only_resolves_headers_from_the_configured_peer(
    peer: str, forwarded: str, expected: str
) -> None:
    app = FastAPI()

    @app.get("/")
    def resolved_client(request: Request) -> dict[str, str | None]:
        return {"client": request.client.host if request.client else None}

    proxy = ProxyHeadersMiddleware(app, trusted_hosts=["172.31.248.0/28"])
    response = TestClient(proxy, client=(peer, 50000)).get(
        "/", headers={"X-Forwarded-For": forwarded}
    )

    assert response.json() == {"client": expected}


@pytest.mark.parametrize("forwarded", ["not-an-ip", "203.0.113.20, not-an-ip", "*"])
def test_real_proxy_middleware_does_not_turn_malformed_input_into_a_valid_ip(
    forwarded: str,
) -> None:
    app = FastAPI()

    @app.get("/")
    def resolved_client(request: Request) -> dict[str, str | None]:
        return {"client": request.client.host if request.client else None}

    proxy = ProxyHeadersMiddleware(app, trusted_hosts=["172.31.248.0/28"])
    response = TestClient(proxy, client=("172.31.248.2", 50000)).get(
        "/", headers={"X-Forwarded-For": forwarded}
    )

    with pytest.raises(ValueError):
        ip_address(response.json()["client"])
