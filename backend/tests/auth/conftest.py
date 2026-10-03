"""Shared router settings for local-identity HTTP contract tests."""

from types import SimpleNamespace

import pytest

import app.common.dependencies.auth as auth_dependencies
import app.systems.access.auth.router as auth_router
from app.systems.access.identity import provider_actions, provider_sessions
from app.systems.manage.workspace.models import WorkspaceProfile


@pytest.fixture(autouse=True)
def unit_workspace_policy(request, monkeypatch: pytest.MonkeyPatch) -> None:
    """Unit identity fakes now include the persisted workspace policy boundary.

    Provider integration journeys always load the actual singleton through PostgreSQL.
    """
    if request.node.get_closest_marker("integration") is not None:
        return
    profile = WorkspaceProfile(
        session_timeout_minutes=60,
        password_min_length=12,
        password_require_mixed_case=True,
        password_require_number=False,
        mfa_policy="optional",
        ip_allow_list=[],
    )
    monkeypatch.setattr(
        provider_actions, "load_workspace_policy", lambda _db: profile, raising=False
    )
    monkeypatch.setattr(
        provider_sessions, "load_workspace_policy", lambda _db: profile, raising=False
    )
    monkeypatch.setattr(
        auth_dependencies, "load_workspace_policy", lambda _db: profile, raising=False
    )


@pytest.fixture
def local_auth_router_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        auth_router,
        "get_settings",
        lambda: SimpleNamespace(public_origin="https://app.example.test"),
    )
    monkeypatch.setattr(
        auth_router, "invitation_completion_permitted", lambda *_args, **_kwargs: True
    )
