"""Owned signed-auth/PostgreSQL world shared by the three session-policy journeys."""

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from secrets import token_urlsafe
from uuid import UUID, uuid4

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from jwt.algorithms import ECAlgorithm
from sqlalchemy import select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.config.provider_instance import assert_provider_instance
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.main import create_app
from app.systems.access.identity.models import IdentityRateLimitBucket, IdentitySession
from app.systems.access.identity.rate_limits import login_fingerprint, rate_limit_fingerprint
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import Membership, User, UserStatus
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from app.systems.platform.scheduling.models import InAppNotification
from tests.auth.provider_jwt_support import signed_access
from tests.conftest import create_member, create_organization, guarded_create_engine

POLICY_FIELDS = (
    "session_timeout_minutes",
    "session_absolute_lifetime_minutes",
    "session_concurrent_limit",
    "mfa_require_admin",
    "mfa_require_member",
    "mfa_require_guest",
    "mfa_grace_days",
    "login_failed_attempt_threshold",
    "login_window_minutes",
    "login_cooldown_minutes",
    "password_min_length",
    "password_require_mixed_case",
    "password_require_number",
    "ip_allow_list",
    "revision",
    "performed_by",
    "updated_at",
)
DEFAULTS = {
    "session_timeout_minutes": 60,
    "session_absolute_lifetime_minutes": None,
    "session_concurrent_limit": None,
    "mfa_require_admin": False,
    "mfa_require_member": False,
    "mfa_require_guest": False,
    "mfa_grace_days": 0,
    "login_failed_attempt_threshold": 5,
    "login_window_minutes": 15,
    "login_cooldown_minutes": 15,
    "ip_allow_list": [],
}


@dataclass
class PolicyWorld:
    owner: Engine
    actor_id: UUID
    provider_id: UUID
    target_id: UUID
    email: str
    password: str = field(repr=False)
    client: TestClient = field(repr=False)
    key: ec.EllipticCurvePrivateKey = field(repr=False)
    session_ids: list[UUID]
    provider_sessions: list[UUID]
    clock: datetime
    factor_id: UUID = field(default_factory=uuid4)
    factor_status: str | None = None
    login_slot: int = 0
    calls: list[tuple[str, str]] = field(default_factory=list)
    hook: Callable[[httpx.Request], httpx.Response | None] | None = None
    handles: list[str] = field(default_factory=list, repr=False)
    csrf: list[str] = field(default_factory=list, repr=False)
    bucket_ids: list[str] = field(default_factory=list, repr=False)

    def access(self, aal="aal1", slot=0, **extra):
        return signed_access(
            self.key,
            user_id=str(self.provider_id),
            session_id=str(self.provider_sessions[slot]),
            issuer=get_settings().supabase_auth_issuer,
            audience=get_settings().supabase_auth_audience,
            extra={"aal": aal, **extra},
        )

    def headers(self, aal="aal1", slot=0, **extra):
        return {"Authorization": f"Bearer {self.access(aal, slot, **extra)}"}

    def policy(self, **values):
        with Session(self.owner) as db:
            profile = db.scalar(select(WorkspaceProfile))
            platform = db.scalar(select(PlatformSettings))
            for name, value in values.items():
                setattr(platform if name in PlatformSettings.__table__.columns else profile,
                        name, value)
            db.commit()

    def sessions(self):
        with Session(self.owner) as db:
            return list(
                db.scalars(
                    select(IdentitySession)
                    .where(IdentitySession.user_id == self.actor_id)
                    .order_by(IdentitySession.created_at, IdentitySession.id)
                )
            )


def shared_provider_sessions():
    """One real provider user with six real provider sessions for this pytest process.

    Admission reads Supabase's ``auth.sessions`` directly, so the sessions must exist.
    Every later provider call in a policy journey goes to the fake transport, so the
    journeys never change this user or its sessions; ``shared_provider_account`` in
    tests/conftest.py yields it once per process and deletes it at the end.
    """
    settings = get_settings()
    assert_provider_instance(
        dict(os.environ), database_url=settings.database_url, expected_user="openslate_runtime"
    )
    email = f"policy-{uuid4().hex}@example.test"
    password = token_urlsafe(32)
    with httpx.Client(
        base_url=settings.supabase_url.rstrip("/") + "/auth/v1/",
        headers={"apikey": settings.supabase_secret_key.get_secret_value()},
        timeout=15,
    ) as admin:
        created = admin.post(
            "admin/users", json={"email": email, "password": password, "email_confirm": True}
        )
        assert created.status_code in {200, 201}
        provider_id = UUID(created.json()["id"])
        try:
            transport = get_supabase_auth_client()
            sessions = [
                transport.verify_access_token(
                    transport.password_grant(email, password).access_token
                ).session_id
                for _ in range(6)
            ]
            yield email, password, provider_id, sessions
        finally:
            deleted = admin.delete(f"admin/users/{provider_id}")
            assert deleted.status_code in {200, 204, 404}


def _local_account(email):
    """The actor's local row for one journey, bound later to the shared provider user."""
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    local_id = None
    try:
        with Session(owner) as db:
            organization = create_organization(db)
            user, _membership = create_member(db, organization,
                email=email,
                username=f"journey-{uuid4().hex[:16]}",
                status=UserStatus.ACTIVE.value,
                role="member",
            )
            db.commit()
            local_id = user.id
        yield local_id, owner
    finally:
        if local_id is not None:
            with Session(owner) as db:
                for session in db.scalars(
                    select(IdentitySession).where(IdentitySession.user_id == local_id)
                ):
                    db.delete(session)
                for notice in db.scalars(
                    select(InAppNotification).where(InAppNotification.recipient_id == local_id)
                ):
                    db.delete(notice)
                db.flush()
                membership = db.scalar(select(Membership).where(Membership.user_id == local_id))
                organization = db.get(WorkspaceProfile, membership.org_id)
                db.connection().execute(
                    text("DELETE FROM public.audit_logs WHERE org_id = :org_id"),
                    {"org_id": organization.id},
                )
                db.delete(membership)
                db.flush()
                user = db.get(User, local_id)
                if user is not None:
                    db.delete(user)
                db.flush()
                db.delete(organization)
                db.commit()
        owner.dispose()


@pytest.fixture
def policy_world(monkeypatch, shared_provider_account):
    email, password, provider_id, provider_sessions = shared_provider_account
    account = _local_account(email)
    actor_id, owner = next(account)
    settings = get_settings()
    client = TestClient(
        create_app(), base_url=settings.public_origin, raise_server_exceptions=False
    )
    client.headers["Origin"] = settings.public_origin
    target_id, target_provider_id = uuid4(), uuid4()
    target_email = f"target-{target_id}@example.test"
    with Session(owner) as db:
        profile = db.scalar(select(WorkspaceProfile))
        platform = db.scalar(select(PlatformSettings))
        saved = {name: getattr(platform if name in PlatformSettings.__table__.columns else profile,
                               name) for name in POLICY_FIELDS}
        episodes = {row.id: row.mfa_required_since for row in db.scalars(select(Membership))}
        actor = db.get(User, actor_id)
        sole_active_membership(db, actor_id).role = "admin"
        actor.supabase_user_id = provider_id
        create_member(db, profile,
                id=target_id,
                email=target_email,
                username=f"target-{target_id.hex}",
                status="active",
                role="member",
                supabase_user_id=target_provider_id,
        )
        for name, value in DEFAULTS.items():
            setattr(platform if name in PlatformSettings.__table__.columns else profile,
                    name, value)
        db.commit()
    transport = get_supabase_auth_client()
    original_transport = transport._transport
    original_jwks = (
        transport._jwks,
        transport._jwks_expires_at,
        transport._next_jwks_fetch_at,
        transport._last_jwks_fetch_failed,
    )
    world = PolicyWorld(
        owner,
        actor_id,
        provider_id,
        target_id,
        email,
        password,
        client,
        ec.generate_private_key(ec.SECP256R1()),
        [],
        # Four sessions sign in below; the last two exist only at the provider.
        list(provider_sessions),
        datetime.now(UTC),
    )
    try:
        jwk = ECAlgorithm.to_jwk(world.key.public_key(), as_dict=True)
        jwk.update({"kid": "test-key", "alg": "ES256", "use": "sig"})

        def respond(request):
            world.calls.append((request.method, request.url.path))
            if world.hook is not None:
                result = world.hook(request)
                if result is not None:
                    return result
            path = request.url.path
            factors = (
                []
                if world.factor_status is None
                else [
                    {
                        "id": str(world.factor_id),
                        "factor_type": "totp",
                        "status": world.factor_status,
                    }
                ]
            )
            user = {
                "id": str(provider_id),
                "email": email,
                "email_confirmed_at": "2026-01-01T00:00:00Z",
                "factors": factors,
            }
            if request.method == "GET" and path == f"/auth/v1/admin/users/{target_provider_id}":
                return httpx.Response(
                    200,
                    json={
                        **user,
                        "id": str(target_provider_id),
                        "email": target_email,
                        "factors": [],
                    },
                )
            if path.endswith("/.well-known/jwks.json"):
                return httpx.Response(200, json={"keys": [jwk]})
            if request.method == "GET" and (
                path == "/auth/v1/user" or path == f"/auth/v1/admin/users/{provider_id}"
            ):
                return httpx.Response(200, json=user)
            if path.endswith("/challenge"):
                return httpx.Response(200, json={"id": str(uuid4()), "type": "totp"})
            if path.endswith("/verify") or path == "/auth/v1/token":
                slot = world.login_slot
                aal = "aal1"
                if path.endswith("/verify"):
                    world.factor_status = "verified"
                    aal = "aal2"
                    claims = transport.verify_access_token(request.headers["authorization"][7:])
                    slot = world.provider_sessions.index(claims.session_id)
                return httpx.Response(
                    200,
                    json={
                        "access_token": world.access(aal, slot),
                        "refresh_token": "owned-test-refresh",
                        "expires_in": 600,
                        "user": user,
                    },
                )
            if request.method == "DELETE" and "/factors/" in path:
                world.factor_status = None
                return httpx.Response(200, json={"id": str(world.factor_id)})
            if path == "/auth/v1/logout":
                return httpx.Response(204)
            return httpx.Response(404)

        transport._transport = httpx.MockTransport(respond)
        transport._jwks = {}
        transport._jwks_expires_at = transport._next_jwks_fetch_at = 0
        transport._last_jwks_fetch_failed = False
        handles, csrf = [], []
        for slot in range(4):
            world.login_slot = slot
            result = client.post("/api/auth/login", json={"email": email, "password": password})
            assert result.status_code == 200
            handles.append(client.cookies.get("openslate_refresh"))
            csrf.append(client.cookies.get("openslate_csrf"))
            client.cookies.clear()
        world.login_slot = 0
        with Session(owner) as db:
            rows = {
                row.provider_session_id: row
                for row in db.scalars(
                    select(IdentitySession).where(IdentitySession.user_id == actor_id)
                )
            }
            assert set(rows) == set(world.provider_sessions[:4])
            world.session_ids = [rows[slot].id for slot in world.provider_sessions[:4]]
        world.handles, world.csrf = handles, csrf
        world.clock = datetime.now(UTC)
        world.calls.clear()
        for module in (
            "provider_sessions",
            "mfa",
            "rate_limits",
            "session_revocation",
            "provider_login",
            "provider_actions",
        ):
            monkeypatch.setattr(
                f"app.systems.access.identity.{module}.utc_now", lambda: world.clock
            )
        monkeypatch.setattr("app.systems.access.policy.checks.utc_now", lambda: world.clock)
        monkeypatch.setattr("app.systems.access.users.security.utc_now", lambda: world.clock)
        yield world
    finally:
        client.close()
        transport._transport = original_transport
        (
            transport._jwks,
            transport._jwks_expires_at,
            transport._next_jwks_fetch_at,
            transport._last_jwks_fetch_failed,
        ) = original_jwks
        with Session(owner) as db:
            ids = [actor_id, target_id]
            fingerprints = [login_fingerprint(email, source) for source in (None, "testclient")]
            fingerprints += [
                rate_limit_fingerprint("login-account", email, None),
                rate_limit_fingerprint("login-source", "testclient", None),
                rate_limit_fingerprint("login-source", "", None),
            ]
            if world is not None:
                fingerprints += world.bucket_ids
            for bucket in db.scalars(
                select(IdentityRateLimitBucket).where(
                    IdentityRateLimitBucket.fingerprint.in_(fingerprints)
                )
            ):
                db.delete(bucket)
            for notice in db.scalars(
                select(InAppNotification).where(InAppNotification.recipient_id.in_(ids))
            ):
                db.delete(notice)
            for event in db.scalars(select(SecurityEvent).where(SecurityEvent.subject_id.in_(ids))):
                db.delete(event)
            for session in db.scalars(
                select(IdentitySession).where(IdentitySession.user_id.in_(ids))
            ):
                db.delete(session)
            db.flush()
            for row in db.scalars(select(Membership)):
                if row.id in episodes:
                    row.mfa_required_since = episodes[row.id]
            profile = db.scalar(select(WorkspaceProfile))
            platform = db.scalar(select(PlatformSettings))
            for name, value in saved.items():
                setattr(platform if name in PlatformSettings.__table__.columns else profile,
                        name, value)
            actor = db.get(User, actor_id)
            membership = sole_active_membership(db, actor_id)
            membership.role, actor.tokens_valid_after = "member", None
            membership.sponsor_user_id, membership.expires_at = None, None
            for row in db.scalars(select(Membership).where(Membership.user_id == target_id)):
                db.delete(row)
            db.flush()
            db.delete(db.get(User, target_id))
            db.commit()
        try:
            next(account)
        except StopIteration:
            pass
