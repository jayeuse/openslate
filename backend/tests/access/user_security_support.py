"""A signed administrator and a bound target with sessions behind the fake provider."""

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi.testclient import TestClient
from jwt.algorithms import ECAlgorithm
from sqlalchemy import select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.integrations.supabase_auth import get_supabase_auth_client
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.auth.provider_jwt_support import signed_access
from tests.conftest import create_member


@dataclass
class SecurityWorld:
    owner: Engine
    actor_id: UUID
    target_id: UUID
    provider_id: UUID
    target_provider_id: UUID
    session_id: UUID
    provider_session_id: UUID
    key: ec.EllipticCurvePrivateKey
    client: TestClient
    factors: list[dict[str, str]]
    calls: list[tuple[str, str]] = field(default_factory=list)
    hook: Callable[[httpx.Request], httpx.Response | None] | None = None

    def headers(self, aal: str = "aal1", **claims: object) -> dict[str, str]:
        token = signed_access(
            self.key,
            user_id=str(self.provider_id),
            session_id=str(self.provider_session_id),
            issuer=get_settings().supabase_auth_issuer,
            audience=get_settings().supabase_auth_audience,
            extra={"aal": aal, **claims},
        )
        return {"Authorization": f"Bearer {token}"}

    def sessions(self) -> list[IdentitySession]:
        with Session(self.owner) as db:
            return list(
                db.scalars(select(IdentitySession).where(IdentitySession.user_id == self.target_id))
            )

    def events(self) -> list[SecurityEvent]:
        with Session(self.owner) as db:
            return list(
                db.scalars(
                    select(SecurityEvent)
                    .where(SecurityEvent.subject_id == self.target_id)
                    .order_by(SecurityEvent.occurred_at, SecurityEvent.id)
                )
            )


def open_security_world(fake_provider_account, monkeypatch):
    """Yield the world for ``fake_provider_account``; a test fixture wraps this generator."""

    email, password, provider_id, actor_id, owner = fake_provider_account
    settings = get_settings()
    with Session(owner) as db:
        actor = db.get(User, actor_id)
        actor.supabase_user_id = provider_id
        membership = sole_active_membership(db, actor_id)
        membership.role = "admin"
        target, _target_membership = create_member(
            db, db.get(WorkspaceProfile, membership.org_id),
            username=f"security-target-{uuid4().hex[:16]}",
            email=f"security-target-{uuid4().hex}@example.test",
            status="active",
            role="member",
            supabase_user_id=uuid4(),
        )
        db.commit()
        target_id, target_provider_id, target_email = (
            target.id,
            target.supabase_user_id,
            target.email,
        )
        db.add(
            IdentitySession(
                user_id=target_id,
                provider_user_id=target_provider_id,
                provider_session_id=uuid4(),
                refresh_token_digest=uuid4().hex * 2,
                csrf_token_digest=uuid4().hex * 2,
                expires_at=datetime.now(UTC) + timedelta(days=1),
            )
        )
        db.commit()
    # The real login route admits a real auth.sessions row through the fake provider.
    # No get_current_identity/user override or fabricated auth.sessions admission.
    client = TestClient(create_app(), base_url=settings.public_origin)
    client.headers["Origin"] = settings.public_origin
    try:
        login = client.post("/api/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200
        with Session(owner) as db:
            session = db.scalar(select(IdentitySession).where(IdentitySession.user_id == actor_id))
            session_id, provider_session_id = session.id, session.provider_session_id
        client.cookies.clear()
        key = ec.generate_private_key(ec.SECP256R1())
        jwk = ECAlgorithm.to_jwk(key.public_key(), as_dict=True)
        jwk.update({"kid": "test-key", "alg": "ES256", "use": "sig"})
        state = SecurityWorld(
            owner,
            actor_id,
            target_id,
            provider_id,
            target_provider_id,
            session_id,
            provider_session_id,
            key,
            client,
            [{"id": str(uuid4()), "factor_type": "totp", "status": "verified"}],
        )

        def provider(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            state.calls.append((request.method, path))
            if state.hook:
                response = state.hook(request)
                if response is not None:
                    return response
            if path.endswith("/.well-known/jwks.json"):
                return httpx.Response(200, json={"keys": [jwk]})
            if path == f"/auth/v1/admin/users/{provider_id}":
                return httpx.Response(
                    200, json={"id": str(provider_id), "email": email, "factors": []}
                )
            if path == f"/auth/v1/admin/users/{target_provider_id}":
                return httpx.Response(
                    200,
                    json={
                        "id": str(target_provider_id),
                        "email": target_email,
                        "factors": state.factors,
                    },
                )
            if path == f"/auth/v1/admin/users/{target_provider_id}/factors":
                return httpx.Response(200, json=state.factors)
            if path.startswith(f"/auth/v1/admin/users/{target_provider_id}/factors/"):
                factor_id = path.rsplit("/", 1)[-1]
                state.factors[:] = [f for f in state.factors if f["id"] != factor_id]
                return httpx.Response(200, json={"id": factor_id})
            if path == "/auth/v1/recover":
                assert json.loads(request.content) == {"email": target_email}
                return httpx.Response(200, json={})
            raise AssertionError(f"Unadmitted provider request {request.method} {path}")

        provider_client = get_supabase_auth_client()
        monkeypatch.setattr(provider_client, "_transport", httpx.MockTransport(provider))
        monkeypatch.setattr(provider_client, "_jwks", {})
        monkeypatch.setattr(provider_client, "_jwks_expires_at", 0)
        monkeypatch.setattr(provider_client, "_next_jwks_fetch_at", 0)
        monkeypatch.setattr(settings, "smtp_host", "smtp.example.test")
        monkeypatch.setattr(settings, "smtp_port", 2525)
        monkeypatch.setattr(settings, "smtp_admin_email", "operator@example.test")
        yield state
    finally:
        client.close()
        with Session(owner) as db:
            for session in db.scalars(
                select(IdentitySession).where(IdentitySession.user_id == target_id)
            ):
                db.delete(session)
            target = db.get(User, target_id)
            for membership in db.scalars(select(Membership).where(Membership.user_id == target_id)):
                db.delete(membership)
            db.flush()
            if target is not None:
                db.delete(target)
            db.commit()
