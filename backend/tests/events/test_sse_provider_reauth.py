"""SSE rechecks provider tokens and local session authority on every interval."""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import app.systems.platform.events.router as events_router


def test_reauth_uses_live_provider_session_not_local_jwt(monkeypatch: pytest.MonkeyPatch) -> None:
    db = Mock()
    client = Mock()
    claims = SimpleNamespace(user_id="provider", session_id="session")
    client.verify_access_token.return_value = claims
    user = SimpleNamespace(id="local-user", role="admin")
    monkeypatch.setattr(events_router, "get_supabase_auth_client", lambda: client, raising=False)
    monkeypatch.setattr(events_router, "allowed_module_ids", lambda *_args: None)
    monkeypatch.setattr(
        events_router,
        "resolve_provider_session",
        lambda *_args: (user, object()),
        raising=False,
    )
    monkeypatch.setattr(events_router, "get_engine", lambda: object())

    @contextmanager
    def session(_engine: object):
        yield db

    monkeypatch.setattr(events_router, "AuditSession", session)

    viewer = events_router._reauthorize_in_database(events_router.EventPrincipal("access"))
    assert viewer == events_router.EventViewer(user_id="local-user", role="admin", module_ids=None)
    client.verify_access_token.assert_called_once_with("access")
