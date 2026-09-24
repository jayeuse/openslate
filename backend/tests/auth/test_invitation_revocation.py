"""Invitation revocation contracts and PostgreSQL persistence behavior."""

from datetime import UTC, datetime, timedelta
from hashlib import sha256
from unittest.mock import Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.core.base_model import utc_now
from app.core.database import get_db
from app.core.security.tokens import TokenType, decode_token
from app.systems.access.auth.aggregate_router import router as access_router
from app.systems.access.identity.contracts import ActionTokenInvalid, InvalidCredentials
from app.systems.access.identity.models import (
    ActionTokenPurpose,
    IdentityActionToken,
    IdentityCredential,
    IdentitySession,
)
from app.systems.access.identity.service import (
    authenticate_password,
    consume_action_token,
    create_credential,
    issue_action_token,
    issue_session,
    validate_access_session,
)
from app.systems.access.users import invitations_router
from app.systems.access.users.coordination import InvitationConflict, InvitationNotFound
from app.systems.access.users.models import IdentityKind, Role, User, UserStatus
from app.systems.access.users.service import resend_invitation_delivery, revoke_invitation
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import SecurityEvent


def test_invitation_revocation_route_exists_and_requires_authentication() -> None:
    app = FastAPI()
    app.include_router(access_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: Mock(spec=Session)

    response = TestClient(app).delete(f"/api/auth/invitations/{uuid7()}")

    assert response.status_code == 401


def test_invitation_revocation_rejects_setup_only_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    role = Role(id=uuid7(), role="admin", description="", permissions={})
    admin = User(
        id=uuid7(),
        email="admin@example.test",
        username="admin",
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        role=role,
        role_id=role.id,
    )
    app = FastAPI()
    app.include_router(access_router, prefix="/api")
    app.dependency_overrides[get_current_identity] = lambda: CurrentIdentity(
        admin, uuid7(), True, True
    )
    app.dependency_overrides[get_db] = lambda: Mock(spec=Session)
    revoke = Mock()
    monkeypatch.setattr(invitations_router, "revoke_invitation", revoke)

    response = TestClient(app).delete(f"/api/auth/invitations/{uuid7()}")

    assert response.status_code == 401
    revoke.assert_not_called()


def test_authorized_invitation_revocation_returns_empty_204(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    role = Role(id=uuid7(), role="admin", description="", permissions={})
    admin = User(
        id=uuid7(),
        email="admin@example.test",
        username="admin",
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        role=role,
        role_id=role.id,
    )
    identity = CurrentIdentity(admin, uuid7(), True, False)
    db = Mock(spec=Session)
    user_id = uuid7()
    app = FastAPI()
    app.include_router(access_router, prefix="/api")
    app.dependency_overrides[get_current_identity] = lambda: identity
    app.dependency_overrides[get_db] = lambda: db
    revoke = Mock()
    monkeypatch.setattr(invitations_router, "revoke_invitation", revoke)

    response = TestClient(app).delete(f"/api/auth/invitations/{user_id}")

    assert response.status_code == 204
    assert response.content == b""
    revoke.assert_called_once_with(db, user_id, actor_id=admin.id)


@pytest.mark.parametrize(
    ("error", "expected_status", "expected_detail"),
    (
        (InvitationNotFound("missing"), 404, "Invitation not found"),
        (InvitationConflict("closed"), 409, "Invitation is no longer pending"),
    ),
)
def test_invitation_revocation_maps_missing_and_closed_states(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    expected_status: int,
    expected_detail: str,
) -> None:
    role = Role(id=uuid7(), role="admin", description="", permissions={})
    admin = User(
        id=uuid7(),
        email="admin@example.test",
        username="admin",
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        role=role,
        role_id=role.id,
    )
    app = FastAPI()
    app.include_router(access_router, prefix="/api")
    app.dependency_overrides[get_current_identity] = lambda: CurrentIdentity(
        admin, uuid7(), True, False
    )
    app.dependency_overrides[get_db] = lambda: Mock(spec=Session)
    monkeypatch.setattr(
        invitations_router, "revoke_invitation", Mock(side_effect=error)
    )

    response = TestClient(app).delete(f"/api/auth/invitations/{uuid7()}")

    assert response.status_code == expected_status
    assert response.json() == {"detail": expected_detail}


@pytest.mark.integration
def test_invitation_token_with_revoked_profile_marker_cannot_be_consumed(
    integration_db: Session,
) -> None:
    suffix = uuid4().hex
    role = Role(role=f"revoked-invitation-{suffix}", description="", permissions={})
    user = User(
        email=f"revoked-{suffix}@example.test",
        username=f"revoked_{suffix}",
        role=role,
        identity_kind=IdentityKind.INTERNAL.value,
        status=UserStatus.PENDING.value,
        invitation_sent_at=None,
    )
    raw_token = f"opaque-invitation-{suffix}"
    integration_db.add(user)
    integration_db.flush()
    integration_db.add(
        IdentityActionToken(
            user_id=user.id,
            purpose=ActionTokenPurpose.INVITATION,
            token_digest=sha256(raw_token.encode("utf-8")).hexdigest(),
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
    )
    integration_db.flush()

    with pytest.raises(ActionTokenInvalid):
        consume_action_token(integration_db, raw_token, ActionTokenPurpose.INVITATION)


@pytest.mark.integration
def test_admin_revocation_blocks_old_link_password_and_setup_session_then_resend_works(
    integration_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = utc_now().replace(microsecond=0)
    suffix = uuid4().hex
    admin_role = integration_db.scalar(
        select(Role).where(Role.role == "admin", Role.is_deleted.is_(False))
    )
    assert admin_role is not None
    member_role = Role(role=f"revocation-member-{suffix}", description="", permissions={})
    admin = User(
        email=f"admin-{suffix}@example.test",
        username=f"admin_{suffix}",
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        invitation_accepted_at=now,
        role=admin_role,
    )
    pending = User(
        email=f"pending-{suffix}@example.test",
        username=f"pending_{suffix}",
        status=UserStatus.PENDING.value,
        identity_kind=IdentityKind.INTERNAL.value,
        invitation_sent_at=now,
        role=member_role,
    )
    integration_db.add_all((admin, pending))
    integration_db.flush()
    old_password = "initial temporary password"
    create_credential(integration_db, pending.id, old_password, temporary=True, now=now)
    old_link = issue_action_token(
        integration_db,
        pending.id,
        ActionTokenPurpose.INVITATION,
        created_by=admin.id,
        now=now,
    )
    setup_session = issue_session(integration_db, pending, now=now)
    integration_db.commit()
    set_audit_actor(integration_db, admin.id)
    monkeypatch.setattr("app.systems.access.users.service._security_event", Mock())

    revoke_invitation(integration_db, pending.id, actor_id=admin.id)

    revoked_profile = integration_db.get(User, pending.id)
    credential = integration_db.get(IdentityCredential, pending.id)
    session = integration_db.get(IdentitySession, setup_session.session_id)
    assert revoked_profile is not None and revoked_profile.invitation_sent_at is None
    assert credential is not None and credential.must_change_password
    assert credential.temporary_password_expires_at is not None
    assert credential.temporary_password_expires_at <= utc_now()
    assert session is not None and session.revoked_at is not None
    claims = decode_token(setup_session.access_token, TokenType.ACCESS)
    assert claims is not None
    assert validate_access_session(
        integration_db, claims, allow_setup=True, now=utc_now() + timedelta(seconds=1)
    ) is None
    with pytest.raises(ActionTokenInvalid):
        consume_action_token(integration_db, old_link, ActionTokenPurpose.INVITATION)
    with pytest.raises(InvalidCredentials):
        authenticate_password(
            integration_db,
            pending.email,
            old_password,
            enforce_rate_limit=False,
        )
    with pytest.raises(InvitationConflict):
        revoke_invitation(integration_db, pending.id, actor_id=admin.id)
    with pytest.raises(InvitationNotFound):
        revoke_invitation(integration_db, uuid7(), actor_id=admin.id)

    accepted = User(
        email=f"accepted-{suffix}@example.test",
        username=f"accepted_{suffix}",
        status=UserStatus.ACTIVE.value,
        identity_kind=IdentityKind.INTERNAL.value,
        invitation_sent_at=now,
        invitation_accepted_at=now,
        role=member_role,
    )
    integration_db.add(accepted)
    integration_db.commit()
    with pytest.raises(InvitationConflict):
        revoke_invitation(integration_db, accepted.id, actor_id=admin.id)

    events = integration_db.scalars(
        select(SecurityEvent).where(
            SecurityEvent.event_type == "user.invitation_revocation",
            SecurityEvent.subject_id == pending.id,
        )
    ).all()
    assert len(events) == 1
    assert events[0].outcome == "success"
    new_password = "replacement temporary password"
    issued = resend_invitation_delivery(
        integration_db,
        pending.id,
        actor_id=admin.id,
        delivery="temporary_password",
        temporary_password=new_password,
    )

    assert issued.user.invitation_sent_at is not None
    assert authenticate_password(
        integration_db,
        pending.email,
        new_password,
        enforce_rate_limit=False,
    ).id == pending.id
