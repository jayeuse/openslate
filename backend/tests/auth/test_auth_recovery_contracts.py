"""Recovery, invitation, and dependency contracts for local Identity routes."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.common.dependencies.auth as dependencies
import app.systems.access.auth.router as auth_router
import app.systems.access.users.acceptance as acceptance
from app.common.dependencies.auth import CurrentIdentity
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    ProviderTokens,
    ProviderUser,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.schemas import ActionTokenCompleteRequest, RecoveryRequest
from app.systems.access.policy.models import AccessPolicyVersion
from app.systems.access.users.models import IdentityKind, UserRole, UserStatus
from app.systems.access.users.permissions import Capability
from tests.auth.test_auth_router_contracts import _request, _role, _user

pytestmark = pytest.mark.usefixtures("local_auth_router_settings")


def _action(monkeypatch, db, *, pending=False):
    user = _user(status=UserStatus.PENDING if pending else UserStatus.ACTIVE)
    user.supabase_user_id = uuid7()
    user.provider_invitation_operation_id = uuid7()
    user.invitation_sent_at = datetime.now(UTC)
    user.invitation_accepted_at = None if pending else datetime.now(UTC)
    client = Mock()
    client.verify_email_action.return_value = ProviderTokens(
        "action-access", "action-refresh", user.supabase_user_id, 600
    )
    verified = ProviderUser(
        user.supabase_user_id,
        None,
        user.email,
        app_metadata={
            "openslate_user_id": str(user.id),
            "openslate_invitation_operation_id": str(user.provider_invitation_operation_id),
        },
    )
    client.get_user.return_value = verified
    client.update_password.return_value = verified
    monkeypatch.setattr(auth_router, "get_supabase_auth_client", lambda: client)
    db.scalar.return_value = user
    db.scalars.return_value = []
    monkeypatch.setattr(acceptance, "_lock_admin_role", lambda *_a: None)
    monkeypatch.setattr(acceptance, "_lock_profile", lambda *_a: user)
    monkeypatch.setattr(acceptance, "_lock_role_any_state", lambda *_a: user.role)
    events = []
    monkeypatch.setattr(
        acceptance, "_security_event", lambda **kw: events.append(kw["outcome"].value)
    )
    monkeypatch.setattr(
        acceptance, "append_security_event", lambda _db, event: events.append(event.outcome.value)
    )
    return user, client, events


def _payload():
    return ActionTokenCompleteRequest(
        token_hash="a" * 56, password="new sufficiently long password"
    )


def test_recovery_completes_with_provider_password_update_without_app_session(monkeypatch):
    db = Mock(spec=Session)
    user, client, _ = _action(monkeypatch, db)
    assert auth_router.complete_recovery(_payload(), _request(), db).status_code == 204
    client.verify_email_action.assert_called_once_with("a" * 56, "recovery")
    client.update_password.assert_called_once_with("action-access", _payload().password)
    client.sign_out.assert_called_once_with("action-access", scope="global")
    assert user.status == UserStatus.ACTIVE.value


def test_invitation_completion_records_attempt_and_commits_success_with_activation(monkeypatch):
    db = Mock(spec=Session)
    user, client, events = _action(monkeypatch, db, pending=True)
    assert auth_router.complete_invitation(_payload(), _request(), db).status_code == 204
    assert user.status == UserStatus.ACTIVE.value
    assert user.invitation_accepted_at is not None
    assert events == ["attempt", "success"]
    client.verify_email_action.assert_called_once_with("a" * 56, "invite")


def test_invitation_completion_records_failure_for_invalid_provider_token(monkeypatch):
    db = Mock(spec=Session)
    _, client, _ = _action(monkeypatch, db, pending=True)
    client.verify_email_action.side_effect = InvalidProviderCredentials("private token details")
    operation_id = uuid7()
    monkeypatch.setattr(auth_router, "begin_invitation_acceptance", lambda *_a: operation_id)
    record = Mock()
    monkeypatch.setattr(auth_router, "record_invitation_acceptance_failure", record)
    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(_payload(), _request(), db)
    assert error.value.status_code == 400
    record.assert_called_once_with(operation_id, None, "invitation token is invalid")
    client.update_password.assert_not_called()


def test_invitation_completion_is_limited_before_provider_or_durable_audit_attempt(monkeypatch):
    db = Mock(spec=Session)
    _, client, events = _action(monkeypatch, db, pending=True)
    monkeypatch.setattr(auth_router, "invitation_completion_permitted", lambda *_a, **_kw: False)
    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(_payload(), _request(), db)
    assert error.value.status_code == 429
    client.verify_email_action.assert_not_called()
    assert events == []


def test_invitation_completion_fails_closed_when_admission_persistence_fails(monkeypatch):
    db = Mock(spec=Session)
    _, client, events = _action(monkeypatch, db, pending=True)
    db.commit.side_effect = SQLAlchemyError("private database details")
    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(_payload(), _request(), db)
    assert error.value.status_code == 503
    client.verify_email_action.assert_not_called()
    assert events == []
    db.rollback.assert_called_once()


def test_invitation_completion_records_failure_when_activation_cannot_commit(monkeypatch):
    db = Mock(spec=Session)
    _, client, events = _action(monkeypatch, db, pending=True)
    db.commit.side_effect = [None, SQLAlchemyError("private database details")]
    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(_payload(), _request(), db)
    assert error.value.status_code == 503
    assert events == ["attempt", "success", "failure"]
    client.sign_out.assert_called_once_with("action-access", scope="global")


@pytest.mark.parametrize("ineligible", ["disabled", "expired", "expiry_race"])
def test_recovery_cannot_change_password_for_an_ineligible_local_user(monkeypatch, ineligible):
    db = Mock(spec=Session)
    user, client, _ = _action(monkeypatch, db)
    if ineligible == "disabled":
        user.status = UserStatus.DISABLED.value
    elif ineligible == "expired":
        user.expires_at = datetime.now(UTC)
    else:

        def expire_after_provider_verification(*_args):
            user.expires_at = datetime.now(UTC)
            return user

        db.scalar.side_effect = expire_after_provider_verification
    with pytest.raises(HTTPException) as error:
        auth_router.complete_recovery(_payload(), _request(), db)
    assert error.value.status_code == 400
    client.update_password.assert_not_called()
    client.sign_out.assert_called_once_with("action-access", scope="global")


def test_recovery_request_has_identical_response_for_known_and_unknown_emails(monkeypatch):
    db = Mock(spec=Session)
    client = Mock()
    monkeypatch.setattr(auth_router, "get_supabase_auth_client", lambda: client)
    monkeypatch.setattr(auth_router, "recovery_request_permitted", lambda *_a, **_kw: True)
    for email in ("known@example.test", "unknown@example.test"):
        assert (
            auth_router.request_recovery(RecoveryRequest(email=email), _request(), db).status_code
            == 204
        )
    assert [call.args[0] for call in client.request_recovery.call_args_list] == [
        "known@example.test",
        "unknown@example.test",
    ]
    db.scalar.assert_not_called()


def test_current_identity_validates_one_transport_and_cookie_mutation_csrf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.info = {}
    user = _user()
    session_id = uuid7()
    client = Mock()
    monkeypatch.setattr(dependencies, "get_supabase_auth_client", lambda: client)
    monkeypatch.setattr(
        dependencies,
        "resolve_provider_session",
        lambda *_args: (user, SimpleNamespace(id=session_id)),
    )
    actor = Mock()
    monkeypatch.setattr(dependencies, "set_audit_actor", actor)

    identity = dependencies.get_current_identity(
        _request(origin=None, authorization="Bearer access-token"),
        SimpleNamespace(credentials="access-token"),
        db,
    )
    assert identity.user is user and not identity.cookie_authenticated
    actor.assert_called_once_with(db, user.id)

    with pytest.raises(HTTPException) as mixed:
        dependencies.get_current_identity(
            _request(cookies="openslate_access=cookie", authorization="Bearer access-token"),
            SimpleNamespace(credentials="access-token"),
            db,
        )
    assert mixed.value.status_code == 401

    cookie_request = _request(cookies="openslate_access=cookie")
    cookie_request.scope["headers"].append((b"x-csrf-token", b"csrf-token"))
    db.get.return_value = SimpleNamespace(csrf_token_digest="digest")
    monkeypatch.setattr(dependencies, "validate_csrf", lambda *_args: False)
    with pytest.raises(HTTPException) as csrf:
        dependencies.get_current_identity(cookie_request, None, db)
    assert csrf.value.status_code == 401


def test_dependency_authorization_fails_closed_for_stale_admin_and_setup_identity() -> None:
    setup = CurrentIdentity(_user(), uuid7(), False, True)
    with pytest.raises(HTTPException) as setup_denied:
        dependencies.get_current_user(setup)
    assert setup_denied.value.status_code == 401

    admin_role = _role(UserRole.ADMIN)
    actor = _user(role=admin_role)
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, actor]
    assert dependencies.require_fresh_exact_admin(db, actor.id) is actor

    db.scalar.side_effect = SQLAlchemyError("database unavailable")
    with pytest.raises(HTTPException) as unavailable:
        dependencies.require_fresh_exact_admin(db, actor.id)
    assert unavailable.value.status_code == 503

    assert dependencies.require_roles(UserRole.ADMIN)(actor) is actor
    with pytest.raises(HTTPException) as denied:
        dependencies.require_roles(UserRole.ADMIN)(_user())
    assert denied.value.status_code == 403


def test_guest_with_an_inconsistent_admin_role_cannot_obtain_admin_authority() -> None:
    admin_role = _role(UserRole.ADMIN)
    guest = _user(role=admin_role)
    guest.identity_kind = IdentityKind.GUEST.value
    db = Mock(spec=Session)
    db.scalar.side_effect = [admin_role, guest]

    with pytest.raises(HTTPException) as exact_admin_denied:
        dependencies.require_fresh_exact_admin(db, guest.id)
    assert exact_admin_denied.value.status_code == 403

    with pytest.raises(HTTPException) as role_denied:
        dependencies.require_roles(UserRole.ADMIN)(guest)
    assert role_denied.value.status_code == 403

    with pytest.raises(HTTPException) as capability_denied:
        dependencies.require_legacy_capability(Capability.DEPARTMENTS_READ)(guest)
    assert capability_denied.value.status_code == 403


def test_fresh_exact_admin_and_capability_reloads_reject_an_expired_identity() -> None:
    now = datetime.now(UTC)
    admin_role = _role(UserRole.ADMIN)
    actor = _user(role=admin_role)
    actor.expires_at = now
    exact_admin_db = Mock(spec=Session)
    exact_admin_db.scalar.side_effect = [admin_role, actor]

    with pytest.raises(HTTPException) as exact_admin_denied:
        dependencies.require_fresh_exact_admin(exact_admin_db, actor.id)
    assert exact_admin_denied.value.status_code == 403

    member_role = _role()
    member_role.permissions = {Capability.DEPARTMENTS_READ.value: True}
    actor.role_id = member_role.id
    actor.role = member_role
    session = IdentitySession(
        id=uuid7(),
        user_id=actor.id,
        refresh_token_digest="refresh-digest",
        csrf_token_digest="csrf-digest",
        expires_at=now + timedelta(days=1),
    )
    capabilities_db = Mock(spec=Session)
    capabilities_db.get.return_value = session
    policy_version = AccessPolicyVersion(singleton_key="workspace", revision=1)
    policy_version.is_deleted = False
    capabilities_db.scalar.side_effect = [policy_version, member_role, actor]
    capabilities_db.execute.return_value.all.return_value = []
    capabilities_db.scalars.return_value.all.return_value = []

    with pytest.raises(HTTPException) as capabilities_denied:
        dependencies.require_fresh_capabilities(
            capabilities_db,
            actor_id=actor.id,
            session_id=session.id,
            expected_role_id=member_role.id,
            capabilities=(Capability.DEPARTMENTS_READ,),
        )
    assert capabilities_denied.value.status_code == 403
    assert capabilities_db.scalar.call_args_list[2].args[0]._for_update_arg.read is False
