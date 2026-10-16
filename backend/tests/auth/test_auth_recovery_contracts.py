"""Recovery, invitation, and dependency contracts for local Identity routes."""

from datetime import UTC, datetime
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
from app.systems.access.identity.schemas import ActionTokenCompleteRequest, RecoveryRequest
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from tests.auth.local_identity_support import contract_request, contract_role, contract_user

pytestmark = pytest.mark.usefixtures("local_auth_router_settings")


@pytest.fixture
def committed_security_events(monkeypatch) -> list[tuple[str, str]]:
    """Record independently committed security events without a database."""

    events: list[tuple[str, str]] = []
    monkeypatch.setattr(
        auth_router.provider_actions.audit_service,
        "append_committed_security_event",
        lambda payload: events.append((payload.event_type, payload.outcome.value)),
    )
    return events


def _action(monkeypatch, db, *, pending=False):
    user, membership = contract_user(status=UserStatus.PENDING if pending else UserStatus.ACTIVE)
    user.supabase_user_id = uuid7()
    membership.provider_invitation_operation_id = uuid7()
    membership.invitation_sent_at = datetime.now(UTC)
    membership.invitation_accepted_at = None if pending else datetime.now(UTC)
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
            "openslate_invitation_operation_id": str(membership.provider_invitation_operation_id),
        },
    )
    client.get_user.return_value = verified
    client.update_password.return_value = verified
    monkeypatch.setattr(auth_router, "get_supabase_auth_client", lambda: client)
    # The profile lock reads ``user``; the administrator lock is one statement on the mock.
    db.dirty = set()
    # Acceptance first reads the invited organization (a Membership column).
    rows = {User: user, WorkspaceProfile: WorkspaceProfile(id=membership.org_id),
            SecurityEvent: None, Membership: membership.org_id}
    db.scalar.side_effect = lambda query: rows[query.column_descriptions[0]["entity"]]
    db.scalars.side_effect = lambda query: (
        Mock(all=lambda: [membership])
        if query.column_descriptions[0]["entity"] is Membership else []
    )
    events = []
    monkeypatch.setattr(
        acceptance, "_security_event", lambda **kw: events.append(kw["outcome"].value)
    )
    monkeypatch.setattr(
        acceptance, "append_security_event", lambda _db, event: events.append(event.outcome.value)
    )
    return user, membership, client, events


def _payload():
    return ActionTokenCompleteRequest(
        token_hash="a" * 56, password="New sufficiently long password"
    )


def test_recovery_completes_with_provider_password_update_without_app_session(
    monkeypatch, committed_security_events
):
    db = Mock(spec=Session)
    user, _membership, client, _ = _action(monkeypatch, db)
    assert auth_router.complete_recovery(_payload(), contract_request(), db).status_code == 204
    client.verify_email_action.assert_called_once_with("a" * 56, "recovery")
    client.update_password.assert_called_once_with("action-access", _payload().password)
    client.sign_out.assert_called_once_with("action-access", scope="global")
    assert user.status == UserStatus.ACTIVE.value
    assert committed_security_events


def test_invitation_completion_records_attempt_and_commits_success_with_activation(monkeypatch):
    db = Mock(spec=Session)
    user, membership, client, events = _action(monkeypatch, db, pending=True)
    assert auth_router.complete_invitation(_payload(), contract_request(), db).status_code == 204
    assert user.status == UserStatus.ACTIVE.value
    assert membership.invitation_accepted_at is not None
    assert events == ["attempt", "success"]
    client.verify_email_action.assert_called_once_with("a" * 56, "invite")


def test_invitation_completion_records_failure_for_invalid_provider_token(monkeypatch):
    db = Mock(spec=Session)
    _, _membership, client, _ = _action(monkeypatch, db, pending=True)
    client.verify_email_action.side_effect = InvalidProviderCredentials("private token details")
    operation_id = uuid7()
    monkeypatch.setattr(auth_router, "begin_invitation_acceptance", lambda *_a: operation_id)
    record = Mock()
    monkeypatch.setattr(auth_router, "record_invitation_acceptance_failure", record)
    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(_payload(), contract_request(), db)
    assert error.value.status_code == 400
    record.assert_called_once_with(operation_id, None, "invitation token is invalid")
    client.update_password.assert_not_called()


def test_invitation_completion_is_limited_before_provider_or_durable_audit_attempt(monkeypatch):
    db = Mock(spec=Session)
    _, _membership, client, events = _action(monkeypatch, db, pending=True)
    monkeypatch.setattr(auth_router, "invitation_completion_permitted", lambda *_a, **_kw: False)
    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(_payload(), contract_request(), db)
    assert error.value.status_code == 429
    client.verify_email_action.assert_not_called()
    assert events == []


def test_invitation_completion_fails_closed_when_admission_persistence_fails(monkeypatch):
    db = Mock(spec=Session)
    _, _membership, client, events = _action(monkeypatch, db, pending=True)
    db.commit.side_effect = SQLAlchemyError("private database details")
    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(_payload(), contract_request(), db)
    assert error.value.status_code == 503
    client.verify_email_action.assert_not_called()
    assert events == []
    db.rollback.assert_called_once()


def test_invitation_completion_records_failure_when_activation_cannot_commit(monkeypatch):
    db = Mock(spec=Session)
    _, _membership, client, events = _action(monkeypatch, db, pending=True)
    db.commit.side_effect = [None, SQLAlchemyError("private database details")]
    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(_payload(), contract_request(), db)
    assert error.value.status_code == 503
    assert events == ["attempt", "success", "failure"]
    client.sign_out.assert_called_once_with("action-access", scope="global")


@pytest.mark.parametrize("ineligible", ["disabled", "expired", "expiry_race"])
def test_recovery_cannot_change_password_for_an_ineligible_local_user(monkeypatch, ineligible):
    db = Mock(spec=Session)
    user, membership, client, _ = _action(monkeypatch, db)
    if ineligible == "disabled":
        user.status = UserStatus.DISABLED.value
    elif ineligible == "expired":
        membership.expires_at = datetime.now(UTC)
    else:

        def expire_after_provider_verification(*_args):
            membership.expires_at = datetime.now(UTC)
            return user

        db.scalar.side_effect = expire_after_provider_verification
    with pytest.raises(HTTPException) as error:
        auth_router.complete_recovery(_payload(), contract_request(), db)
    assert error.value.status_code == 400
    client.update_password.assert_not_called()
    client.sign_out.assert_called_once_with("action-access", scope="local")


def test_recovery_request_has_identical_response_for_known_and_unknown_emails(
    monkeypatch, committed_security_events
):
    db = Mock(spec=Session)
    client = Mock()
    monkeypatch.setattr(auth_router, "get_supabase_auth_client", lambda: client)
    monkeypatch.setattr(
        auth_router.provider_actions.rate_limits,
        "recovery_request_permitted",
        lambda *_a, **_kw: True,
    )
    recorded_per_email = []
    for email in ("known@example.test", "unknown@example.test"):
        before = len(committed_security_events)
        assert (
            auth_router.request_recovery(
                RecoveryRequest(email=email), contract_request(), db
            ).status_code
            == 204
        )
        recorded_per_email.append(committed_security_events[before:])
    assert recorded_per_email[0] == recorded_per_email[1]
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
    user, _membership = contract_user()
    session_id = uuid7()
    client = Mock()
    monkeypatch.setattr(dependencies, "get_supabase_auth_client", lambda: client)
    monkeypatch.setattr(
        dependencies,
        "resolve_provider_session",
        lambda *_args, **_kwargs: (user, SimpleNamespace(id=session_id)),
    )
    actor = Mock()
    monkeypatch.setattr(dependencies, "set_audit_actor", actor)

    identity = dependencies.get_current_identity(
        contract_request(origin=None, authorization="Bearer access-token"),
        SimpleNamespace(credentials="access-token"),
        db,
    )
    assert identity.user is user and not identity.cookie_authenticated
    actor.assert_called_once_with(db, user.id)

    with pytest.raises(HTTPException) as mixed:
        dependencies.get_current_identity(
            contract_request(
                cookies="openslate_access=cookie", authorization="Bearer access-token"
            ),
            SimpleNamespace(credentials="access-token"),
            db,
        )
    assert mixed.value.status_code == 401

    cookie_request = contract_request(cookies="openslate_access=cookie")
    cookie_request.scope["headers"].append((b"x-csrf-token", b"csrf-token"))
    db.get.return_value = SimpleNamespace(csrf_token_digest="digest")
    monkeypatch.setattr(dependencies, "validate_csrf", lambda *_args: False)
    with pytest.raises(HTTPException) as csrf:
        dependencies.get_current_identity(cookie_request, None, db)
    assert csrf.value.status_code == 401


def test_dependency_authorization_fails_closed_for_stale_admin_and_setup_identity() -> None:
    user, membership = contract_user()
    setup = CurrentIdentity(user, uuid7(), False, True)
    with pytest.raises(HTTPException) as setup_denied:
        dependencies.get_current_user(setup)
    assert setup_denied.value.status_code == 401

    actor, admin_membership = contract_user(role=contract_role(UserRole.ADMIN))
    db = Mock(spec=Session)
    db.scalar.side_effect = [actor]
    db.dirty = set()
    db.scalars.return_value.all.return_value = [admin_membership]
    assert dependencies.require_fresh_exact_admin(db, actor.id) is actor

    db.scalar.side_effect = SQLAlchemyError("database unavailable")
    with pytest.raises(HTTPException) as unavailable:
        dependencies.require_fresh_exact_admin(db, actor.id)
    assert unavailable.value.status_code == 503

    assert dependencies.require_admin(actor, db) is actor
    db.scalars.return_value.all.return_value = [membership]
    with pytest.raises(HTTPException) as denied:
        dependencies.require_admin(user, db)
    assert denied.value.status_code == 403


def test_fresh_exact_admin_rejects_a_member_that_was_an_administrator() -> None:
    demoted, membership = contract_user(role=contract_role(UserRole.MEMBER))
    db = Mock(spec=Session)
    db.scalar.side_effect = [demoted]
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]

    with pytest.raises(HTTPException) as exact_admin_denied:
        dependencies.require_fresh_exact_admin(db, demoted.id)
    assert exact_admin_denied.value.status_code == 403
    db.rollback.assert_called_once()


def test_fresh_exact_admin_rejects_an_expired_identity() -> None:
    actor, membership = contract_user(role=contract_role(UserRole.ADMIN))
    membership.expires_at = datetime.now(UTC)
    exact_admin_db = Mock(spec=Session)
    exact_admin_db.scalar.side_effect = [actor]
    exact_admin_db.dirty = set()
    exact_admin_db.scalars.return_value.all.return_value = [membership]

    with pytest.raises(HTTPException) as exact_admin_denied:
        dependencies.require_fresh_exact_admin(exact_admin_db, actor.id)
    assert exact_admin_denied.value.status_code == 403


@pytest.mark.parametrize("kind", ["invite", "recovery"])
def test_weak_action_password_returns_safe_422_without_consuming_token(monkeypatch, kind):
    db = Mock(spec=Session)
    _user_value, _membership, client, _events = _action(monkeypatch, db, pending=kind == "invite")
    policy = PlatformSettings(
        password_min_length=16, password_require_mixed_case=True, password_require_number=True
    )
    monkeypatch.setattr(
        auth_router.provider_actions, "load_platform_policy", lambda _db: policy
    )
    payload = ActionTokenCompleteRequest(token_hash="a" * 56, password="NoNumbersPassword")
    action = auth_router.complete_invitation if kind == "invite" else auth_router.complete_recovery

    with pytest.raises(HTTPException) as denied:
        action(payload, contract_request(), db)

    assert denied.value.status_code == 422
    assert denied.value.detail["code"] == "password_policy_violation"
    assert "16" in denied.value.detail["message"]
    assert payload.password not in str(denied.value.detail)
    client.verify_email_action.assert_not_called()
    client.update_password.assert_not_called()
