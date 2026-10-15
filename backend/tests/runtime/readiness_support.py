"""Readiness state, settings, and provider transport shared by the readiness tests."""

from types import SimpleNamespace

import httpx

from app.core import readiness
from app.core.config import Settings
from tests.config_support import settings_values

READINESS_PUBLISHABLE_KEY = "sb_publishable_readiness_test_only"


def reset_readiness_state() -> None:
    executor = readiness._probe_executor
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)
    readiness._probe_executor = None
    readiness._snapshot_future = None
    readiness.get_readiness_engine.cache_clear()


def readiness_settings(**overrides: object) -> Settings:
    values = settings_values(
        supabase_url="http://supabase.test",
        supabase_publishable_key=READINESS_PUBLISHABLE_KEY,
        readiness_caller_timeout_seconds=0.5,
        smtp_host="mailpit",
        smtp_port=1025,
        smtp_admin_email="admin@openslate.test",
    )
    values.update(overrides)
    return Settings(**values, _env_file=None)


def install_provider_transport(monkeypatch, handler):
    transport = httpx.MockTransport(handler)

    def client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return httpx.Client(*args, **kwargs)

    # A private facade avoids replacing httpx.Client globally, which TestClient
    # itself uses. The readiness module imports this module at implementation.
    provider_http = SimpleNamespace(
        Client=client_factory,
        Timeout=httpx.Timeout,
        HTTPError=httpx.HTTPError,
        RequestError=httpx.RequestError,
        TimeoutException=httpx.TimeoutException,
    )
    monkeypatch.setattr(readiness, "httpx", provider_http, raising=False)


def install_readiness_settings(monkeypatch, settings: Settings) -> None:
    import app.main as main

    monkeypatch.setattr(readiness, "get_settings", lambda: settings)
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    monkeypatch.setattr(readiness, "_probe_database", lambda: True)


def component(status: str, *, required: bool = True) -> dict[str, object]:
    return {"status": status, "required": required}
