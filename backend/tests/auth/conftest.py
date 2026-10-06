"""Shared router settings for local-identity HTTP contract tests."""

from types import SimpleNamespace

import pytest

import app.common.dependencies.auth as auth_dependencies
import app.systems.access.auth.router as auth_router
from app.systems.access.identity import mfa, provider_actions, provider_login, provider_sessions
from app.systems.access.users import sessions_router
from app.systems.manage.workspace.models import WorkspaceProfile


@pytest.fixture(autouse=True)
def unit_workspace_policy(request, monkeypatch: pytest.MonkeyPatch) -> WorkspaceProfile | None:
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
        mfa_require_admin=False,
        mfa_require_member=False,
        mfa_require_guest=False,
        mfa_grace_days=0,
        session_absolute_lifetime_minutes=None,
        session_concurrent_limit=None,
        login_failed_attempt_threshold=5,
        login_window_minutes=15,
        login_cooldown_minutes=15,
        ip_allow_list=[],
    )
    monkeypatch.setattr(
        provider_actions, "load_workspace_policy", lambda _db: profile, raising=False
    )
    monkeypatch.setattr(
        provider_sessions, "load_workspace_policy", lambda _db: profile, raising=False
    )
    monkeypatch.setattr(sessions_router, "load_workspace_policy", lambda _db: profile)
    monkeypatch.setattr(mfa, "load_workspace_policy", lambda _db: profile)
    monkeypatch.setattr(provider_login, "load_workspace_policy", lambda _db: profile)
    monkeypatch.setattr(
        auth_dependencies, "load_workspace_policy", lambda _db: profile, raising=False
    )

    return profile


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
