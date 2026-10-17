"""SSE rechecks provider tokens and local session authority on every interval."""

import asyncio
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.platform.events.router as events_router
from app.core.integrations.supabase_auth import InvalidProviderToken
from app.systems.access.identity import provider_sessions
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import Membership, UserRole
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from tests.auth.provider_jwt_support import client_for_key, signed_access
from tests.users.user_support import local_user


@pytest.fixture(autouse=True)
def nonoperator_snapshot(monkeypatch):
    monkeypatch.setattr(events_router, "is_platform_operator", lambda *_args: False)


def test_reauth_uses_live_provider_session_not_local_jwt(monkeypatch: pytest.MonkeyPatch) -> None:
    db = Mock()
    client = Mock()
    claims = SimpleNamespace(user_id="provider", session_id="session")
    client.verify_access_token.return_value = claims
    user = SimpleNamespace(id="local-user", role="admin", supabase_user_id=uuid4())
    membership = Membership(user_id=user.id, role="admin")
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]
    monkeypatch.setattr(events_router, "get_supabase_auth_client", lambda: client, raising=False)
    monkeypatch.setattr(events_router, "allowed_module_ids", lambda *_args: None)
    monkeypatch.setattr(events_router, "readable_board_ids", lambda *_args: None, raising=False)
    monkeypatch.setattr(
        events_router, "load_workspace_policy",
        lambda _db, **_kwargs: WorkspaceProfile(ip_allow_list=[]),
    )
    monkeypatch.setattr(
        events_router,
        "resolve_provider_session",
        lambda *_args: (user, SimpleNamespace(active_org_id=uuid7())),
        raising=False,
    )
    monkeypatch.setattr(events_router, "current_membership", lambda *_args: membership)
    db.get.return_value = WorkspaceProfile(is_deleted=False)
    monkeypatch.setattr(events_router, "recent_provider_user", lambda _id: object())
    monkeypatch.setattr(events_router, "requires_mfa", lambda *_args: False)
    monkeypatch.setattr(events_router, "get_engine", lambda: object())

    @contextmanager
    def session(_engine: object):
        yield db

    monkeypatch.setattr(events_router, "AuditSession", session)

    viewer = events_router._reauthorize_in_database(events_router.EventPrincipal("access"))
    assert viewer is not None and viewer.org_id is not None
    assert replace(viewer, org_id=None) == events_router.EventViewer(
        user_id="local-user", role="admin", module_ids=None, board_ids=None
    )
    client.verify_access_token.assert_called_once_with("access")


@pytest.mark.parametrize("denial", ["mfa_required", "ip_not_allowed"])
def test_sse_reauthorization_enforces_signed_mfa_and_current_ip_policy(monkeypatch, denial):
    key = ec.generate_private_key(ec.SECP256R1())
    local_id, provider_id, provider_session = uuid4(), uuid4(), uuid4()
    factors = (
        [{"id": str(uuid4()), "factor_type": "totp", "status": "verified"}]
        if denial == "mfa_required"
        else []
    )
    provider = client_for_key(key, user_id=provider_id, factors=factors)
    user, membership = local_user(UserRole.MEMBER)
    user.id = local_id
    membership.user_id = local_id
    user.supabase_user_id = provider_id
    user.email = "events@example.test"
    user.username = "events"
    session = IdentitySession(
        id=uuid4(),
        user_id=local_id,
        active_org_id=uuid4(),
        provider_user_id=provider_id,
        provider_session_id=provider_session,
        created_at=datetime.now(UTC),
        refreshed_at=datetime.now(UTC),
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    db = Mock(spec=Session)
    db.dirty = set()
    db.get.return_value = WorkspaceProfile(is_deleted=False, ip_allow_list=[])
    db.scalars.return_value.all.return_value = [membership]
    db.scalar.side_effect = lambda query: (
        session if query.column_descriptions[0]["entity"] is IdentitySession else user
    )
    db.execute.return_value.scalar_one.return_value = True
    profile = WorkspaceProfile(
        mfa_require_admin=False,
        mfa_require_member=False,
        mfa_require_guest=False,
        mfa_grace_days=0,
        ip_allow_list=[] if denial == "mfa_required" else ["10.0.0.0/8"],
    )
    monkeypatch.setattr(provider_sessions, "load_workspace_policy", lambda _db, **_kwargs: profile)
    monkeypatch.setattr(provider_sessions, "load_platform_policy", lambda _db: PlatformSettings(
        session_timeout_minutes=60, session_absolute_lifetime_minutes=None,
    ))
    monkeypatch.setattr(
        events_router, "load_workspace_policy", lambda _db, **_kwargs: profile, raising=False
    )
    monkeypatch.setattr(events_router, "get_supabase_auth_client", lambda: provider)
    monkeypatch.setattr(events_router, "allowed_module_ids", lambda *_args: None)
    monkeypatch.setattr(events_router, "get_engine", lambda: object())

    @contextmanager
    def database(_engine):
        yield db

    monkeypatch.setattr(events_router, "AuditSession", database)
    token = signed_access(key, user_id=str(provider_id), session_id=str(provider_session))
    principal = SimpleNamespace(access_token=token, client_ip="203.0.113.8", org_id=None)
    with pytest.raises(HTTPException) as caught:
        events_router._reauthorize_in_database(principal)
    assert caught.value.status_code == 403
    assert caught.value.detail["code"] == denial


def test_reauthorization_checks_claims_then_uses_a_short_lived_database_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def exercise() -> None:
        invalid_principal = events_router.EventPrincipal("invalid-token")
        valid_principal = events_router.EventPrincipal("valid-token")

        module_id, board_id = uuid4(), uuid4()
        account = SimpleNamespace(id=uuid4(), role="member", supabase_user_id=uuid4())
        expected = events_router.EventViewer(
            user_id=account.id,
            role="member",
            module_ids=frozenset({module_id}),
            board_ids=frozenset({board_id}),
        )
        entered: list[object] = []
        exited: list[object] = []
        claims = SimpleNamespace(user_id="provider-user", session_id="provider-session")

        class ProviderAuth:
            def verify_access_token(self, token: str) -> object:
                if token == "invalid-token":
                    raise InvalidProviderToken("invalid provider token")
                assert token == "valid-token"
                return claims

        provider = ProviderAuth()
        monkeypatch.setattr(events_router, "get_supabase_auth_client", lambda: provider)

        class Session:
            def __init__(self, engine: object) -> None:
                assert engine == "engine"
                entered.append(engine)

            def __enter__(self) -> object:
                return database

            def __exit__(self, *_args: object) -> None:
                exited.append(database)

        database = SimpleNamespace(dirty=set(), get=lambda *_args: WorkspaceProfile(
            is_deleted=False
        ), scalars=lambda _query: SimpleNamespace(
            all=lambda: [Membership(user_id=account.id, role="member")]
        ))

        def resolve_provider_session(
            db: object, verified_claims: object, client: object
        ) -> tuple[object, object]:
            assert db is database
            assert verified_claims is claims
            assert client is provider
            return account, SimpleNamespace(active_org_id=uuid7())

        def readable_modules(db: object, user: object, level: object) -> frozenset[object]:
            assert db is database
            assert user is account
            return frozenset({module_id})

        def readable_boards(db: object, user: object) -> frozenset[object]:
            assert db is database
            assert user is account
            return frozenset({board_id})

        monkeypatch.setattr(events_router, "allowed_module_ids", readable_modules)
        monkeypatch.setattr(events_router, "readable_board_ids", readable_boards, raising=False)
        monkeypatch.setattr(events_router, "get_engine", lambda: "engine")
        monkeypatch.setattr(events_router, "AuditSession", Session)
        monkeypatch.setattr(events_router, "resolve_provider_session", resolve_provider_session)
        monkeypatch.setattr(
            events_router, "current_membership",
            lambda *_args: Membership(user_id=account.id, role="member"),
        )
        monkeypatch.setattr(events_router, "recent_provider_user", lambda _id: object())
        monkeypatch.setattr(events_router, "requires_mfa", lambda *_args: False)
        monkeypatch.setattr(
            events_router, "load_workspace_policy",
            lambda _db, **_kwargs: WorkspaceProfile(ip_allow_list=[]),
        )

        assert await events_router.reauthorize_event_principal(invalid_principal) is None
        assert entered == exited == []
        viewer = await events_router.reauthorize_event_principal(valid_principal)
        assert viewer is not None and viewer.org_id is not None
        assert replace(viewer, org_id=None) == expected
        assert entered == ["engine"]
        assert exited == [database]

    asyncio.run(exercise())
