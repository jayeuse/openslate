"""In-process Supabase Auth fake for integration tests whose subject is not the provider.

Workspace, export, report, audit and security-event journeys check OpenSlate behavior.
They sign in through OpenSlate's real ``/api/auth/login`` (or ``admit_provider_session``)
against this fake instead of creating, password-hashing and deleting a GoTrue user per
test. Real provider semantics keep their own acceptance tests
(``tests/auth/test_provider_*``, ``test_email_change_integration``,
``test_invitation_revocation`` and ``test_provider_stepup_acceptance``).

The fake owns the provider's identities, passwords, factors and rotating refresh tokens.
Admission and every authenticated request also read Supabase's ``auth.sessions`` directly,
and no test role may write it, so each session the fake issues is a real row: its users
are leased from ``RealSessionPool``, created once per pytest process. One gap follows:
a fake sign-out ends the fake's session but leaves that real row, so these tests must not
rely on provider liveness (rather than local revocation) after a sign-out.
"""

import json
import os
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from uuid import UUID, uuid4

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from jwt.algorithms import ECAlgorithm
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.config.provider_instance import assert_provider_instance
from app.core.integrations.supabase_auth import SupabaseAuthClient, get_supabase_auth_client
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import Membership, User, UserStatus
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.platform.scheduling.models import InAppNotification
from tests.auth.provider_jwt_support import signed_access
from tests.conftest import create_member, create_organization, guarded_create_engine

# Long enough that a browser refresh keeps the current access token (its fast path).
ACCESS_LIFETIME = timedelta(hours=1)
SESSIONS_PER_USER = 6


class RealSessionPool:
    """Real provider users, each with real ``auth.sessions`` rows, for this pytest process.

    Tests lease users in order (the first ``add`` of a fake gets user 0) and free the
    sessions by deleting their local ``IdentitySession`` rows at teardown, because
    ``provider_session_id`` is unique. Only this class calls the real provider.
    """

    def __init__(self) -> None:
        self.users: list[tuple[UUID, tuple[UUID, ...]]] = []
        self._created: list[UUID] = []

    def user(self, index: int) -> tuple[UUID, tuple[UUID, ...]]:
        while len(self.users) <= index:
            self.users.append(self._create())
        return self.users[index]

    def _admin(self) -> httpx.Client:
        settings = get_settings()
        assert_provider_instance(
            dict(os.environ), database_url=settings.database_url, expected_user="openslate_runtime"
        )
        return httpx.Client(
            base_url=settings.supabase_url.rstrip("/") + "/auth/v1/",
            headers={"apikey": settings.supabase_secret_key.get_secret_value()},
            timeout=15,
        )

    def _create(self) -> tuple[UUID, tuple[UUID, ...]]:
        email = f"fake-pool-{uuid4().hex}@example.test"
        password = token_urlsafe(32)
        with self._admin() as admin:
            created = admin.post(
                "admin/users", json={"email": email, "password": password, "email_confirm": True}
            )
        assert created.status_code in {200, 201}
        provider_id = UUID(created.json()["id"])
        self._created.append(provider_id)
        # A separate client: the shared one may already route to a fake.
        real = SupabaseAuthClient(get_settings())
        sessions = tuple(
            real.verify_access_token(real.password_grant(email, password).access_token).session_id
            for _ in range(SESSIONS_PER_USER)
        )
        return provider_id, sessions

    def close(self) -> None:
        if not self._created:
            return
        with self._admin() as admin:
            for provider_id in self._created:
                deleted = admin.delete(f"admin/users/{provider_id}")
                assert deleted.status_code in {200, 204, 404}


_POOL_KEY = pytest.StashKey[RealSessionPool]()


def real_session_pool(config: pytest.Config) -> RealSessionPool:
    """The process-wide pool; its users are deleted when pytest finishes."""

    pool = config.stash.get(_POOL_KEY, None)
    if pool is None:
        pool = config.stash[_POOL_KEY] = RealSessionPool()
        config.add_cleanup(pool.close)
    return pool


@dataclass
class FakeIdentity:
    id: UUID
    email: str
    password: str = field(repr=False)
    factors: list[dict[str, str]] = field(default_factory=list)
    banned_until: str | None = None

    def json(self) -> dict[str, object]:
        return {
            "id": str(self.id),
            "email": self.email,
            "email_confirmed_at": "2026-01-01T00:00:00Z",
            "banned_until": self.banned_until,
            "factors": self.factors,
        }


@dataclass
class FakeProvider:
    """Provider state plus every request it received, as ``(method, path)``."""

    pool: RealSessionPool | None = None
    key: ec.EllipticCurvePrivateKey = field(
        default_factory=lambda: ec.generate_private_key(ec.SECP256R1()), repr=False
    )
    identities: dict[UUID, FakeIdentity] = field(default_factory=dict)
    sessions: dict[tuple[UUID, UUID], str] = field(default_factory=dict)
    refresh_tokens: dict[str, tuple[UUID, UUID]] = field(default_factory=dict, repr=False)
    calls: list[tuple[str, str]] = field(default_factory=list)
    hook: Callable[[httpx.Request], httpx.Response | None] | None = None
    _unused: dict[UUID, list[UUID]] = field(default_factory=dict, repr=False)

    def add(self, email: str, password: str) -> UUID:
        """Register an identity; with a pool it is the next real user, with its sessions."""

        if self.pool is None:
            provider_id = uuid4()
        else:
            provider_id, sessions = self.pool.user(len(self._unused))
            self._unused[provider_id] = list(sessions)
        self.identities[provider_id] = FakeIdentity(provider_id, email, password)
        return provider_id

    def _new_session(self, identity: FakeIdentity) -> UUID:
        if identity.id not in self._unused:
            return uuid4()  # No pool: only for flows that never admit a session.
        unused = self._unused[identity.id]
        assert unused, "Raise SESSIONS_PER_USER: this test signs in more often than that"
        return unused.pop(0)

    def access(self, user_id: UUID, session_id: UUID, aal: str = "aal1") -> str:
        settings = get_settings()
        return signed_access(
            self.key,
            user_id=str(user_id),
            session_id=str(session_id),
            issuer=settings.supabase_auth_issuer,
            audience=settings.supabase_auth_audience,
            expires_at=datetime.now(UTC) + ACCESS_LIFETIME,
            extra={"aal": aal},
        )

    def _issue(self, identity: FakeIdentity, session_id: UUID) -> httpx.Response:
        refresh = token_urlsafe(24)
        self.refresh_tokens[refresh] = (identity.id, session_id)
        aal = self.sessions[(identity.id, session_id)]
        return httpx.Response(
            200,
            json={
                "access_token": self.access(identity.id, session_id, aal),
                "refresh_token": refresh,
                "expires_in": int(ACCESS_LIFETIME.total_seconds()),
                "user": identity.json(),
            },
        )

    def _bearer(self, request: httpx.Request) -> tuple[UUID, UUID] | None:
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        try:
            claims = jwt.decode(
                token,
                self.key.public_key(),
                algorithms=["ES256"],
                audience=get_settings().supabase_auth_audience,
            )
            subject = (UUID(claims["sub"]), UUID(claims["session_id"]))
        except (jwt.InvalidTokenError, KeyError, ValueError):
            return None
        return subject if subject in self.sessions else None

    def _token(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content or b"{}")
        if request.url.params.get("grant_type") == "password":
            identity = next(
                (
                    item
                    for item in self.identities.values()
                    if item.email == body.get("email") and item.password == body.get("password")
                ),
                None,
            )
            if identity is None:
                return httpx.Response(400, json={"error": "invalid_grant"})
            session_id = self._new_session(identity)
            self.sessions[(identity.id, session_id)] = "aal1"
            return self._issue(identity, session_id)
        owner = self.refresh_tokens.pop(body.get("refresh_token", ""), None)
        if owner is None or owner not in self.sessions or owner[0] not in self.identities:
            return httpx.Response(400, json={"error": "invalid_grant"})
        return self._issue(self.identities[owner[0]], owner[1])

    def respond(self, request: httpx.Request) -> httpx.Response:
        method, path = request.method, request.url.path
        self.calls.append((method, path))
        if self.hook is not None:
            hooked = self.hook(request)
            if hooked is not None:
                return hooked
        if path.endswith("/.well-known/jwks.json"):
            jwk = ECAlgorithm.to_jwk(self.key.public_key(), as_dict=True)
            jwk.update({"kid": "test-key", "alg": "ES256", "use": "sig"})
            return httpx.Response(200, json={"keys": [jwk]})
        if method == "POST" and path == "/auth/v1/token":
            return self._token(request)
        if path == "/auth/v1/user":
            subject = self._bearer(request)
            if subject is None or subject[0] not in self.identities:
                return httpx.Response(401, json={"error": "invalid_token"})
            identity = self.identities[subject[0]]
            if method == "PUT":
                identity.password = json.loads(request.content)["password"]
            return httpx.Response(200, json=identity.json())
        if method == "POST" and path == "/auth/v1/logout":
            subject = self._bearer(request)
            if subject is None:
                return httpx.Response(401, json={"error": "invalid_token"})
            ended = (
                [key for key in self.sessions if key[0] == subject[0]]
                if request.url.params.get("scope") == "global"
                else [subject]
            )
            for key in ended:
                self.sessions.pop(key, None)
            return httpx.Response(204)
        if method == "POST" and path == "/auth/v1/recover":
            return httpx.Response(200, json={})
        prefix = "/auth/v1/admin/users/"
        if path.startswith(prefix):
            return self._admin(method, path.removeprefix(prefix).split("/"))
        return httpx.Response(404, json={"error": "not_found"})

    def _admin(self, method: str, parts: list[str]) -> httpx.Response:
        try:
            identity = self.identities[UUID(parts[0])]
        except (KeyError, ValueError):
            return httpx.Response(404, json={"error": "user_not_found"})
        if len(parts) == 1 and method == "GET":
            return httpx.Response(200, json=identity.json())
        if len(parts) == 1 and method == "DELETE":
            del self.identities[identity.id]
            for key in [key for key in self.sessions if key[0] == identity.id]:
                del self.sessions[key]
            return httpx.Response(200, json=identity.json())
        if parts[1:] == ["factors"] and method == "GET":
            return httpx.Response(200, json=identity.factors)
        if len(parts) == 3 and parts[1] == "factors" and method == "DELETE":
            identity.factors[:] = [item for item in identity.factors if item["id"] != parts[2]]
            return httpx.Response(200, json={"id": parts[2]})
        return httpx.Response(404, json={"error": "not_found"})


def install_fake_provider(
    monkeypatch: pytest.MonkeyPatch, pool: RealSessionPool | None = None
) -> FakeProvider:
    """Route the shared provider client to a new fake; ``monkeypatch`` undoes it.

    Pass ``real_session_pool(config)`` whenever OpenSlate will admit a session.
    """

    fake = FakeProvider(pool)
    client = get_supabase_auth_client()
    monkeypatch.setattr(client, "_transport", httpx.MockTransport(fake.respond))
    monkeypatch.setattr(client, "_jwks", {})
    monkeypatch.setattr(client, "_jwks_expires_at", 0.0)
    monkeypatch.setattr(client, "_next_jwks_fetch_at", 0.0)
    monkeypatch.setattr(client, "_last_jwks_fetch_failed", False)
    return fake


@pytest.fixture
def fake_provider(monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest) -> FakeProvider:
    return install_fake_provider(monkeypatch, real_session_pool(request.config))


def owned_account(
    fake: FakeProvider, *, prefix: str = "auth-journey", organization_id: UUID | None = None,
) -> Iterator[tuple]:
    """``(email, password, provider_id, local_id, owner)``, like the real ``fake_provider_account``.

    The local row starts unbound: tests bind ``supabase_user_id`` themselves.
    """

    email = f"{prefix}-{uuid4().hex}@example.test"
    password = token_urlsafe(32)
    provider_id = fake.add(email, password)
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    local_id = None
    try:
        with Session(owner) as db:
            organization = (
                create_organization(db) if organization_id is None
                else db.get(WorkspaceProfile, organization_id)
            )
            user, _membership = create_member(db, organization,
                email=email,
                username=f"journey-{uuid4().hex[:16]}",
                status=UserStatus.ACTIVE.value,
                role="member",
            )
            db.commit()
            local_id = user.id
        yield email, password, provider_id, local_id, owner
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
                if organization_id is None:
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
                if organization_id is None:
                    db.delete(organization)
                db.commit()
        owner.dispose()


@pytest.fixture
def fake_provider_account(fake_provider: FakeProvider) -> Iterator[tuple]:
    yield from owned_account(fake_provider)
