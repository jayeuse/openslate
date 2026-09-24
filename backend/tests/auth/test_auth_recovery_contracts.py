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
from app.common.dependencies.auth import CurrentIdentity
from app.systems.access.identity.models import ActionTokenPurpose, IdentitySession
from app.systems.access.identity.schemas import ActionTokenCompleteRequest, RecoveryRequest
from app.systems.access.identity.service import ActionTokenInvalid
from app.systems.access.policy.models import AccessPolicyVersion
from app.systems.access.users.models import IdentityKind, UserRole, UserStatus
from app.systems.access.users.permissions import Capability
from tests.auth.test_auth_router_contracts import _request, _role, _user

pytestmark = pytest.mark.usefixtures("local_auth_router_settings")


def test_recovery_and_invitation_completion_activate_valid_action_tokens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user()
    action = SimpleNamespace(user_id=user.id)
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    monkeypatch.setattr(auth_router, "consume_action_token", Mock(return_value=action))
    monkeypatch.setattr(auth_router, "replace_password", Mock())
    monkeypatch.setattr(auth_router, "begin_invitation_acceptance", lambda *_args: uuid7())
    monkeypatch.setattr(auth_router, "append_invitation_acceptance_success", lambda *_args: None)
    monkeypatch.setattr(auth_router, "record_invitation_acceptance_failure", lambda *_args: None)
    db.get.return_value = user

    assert auth_router.complete_recovery(payload, _request(), db).status_code == 204
    user.status = UserStatus.PENDING.value
    assert auth_router.complete_invitation(payload, _request(), db).status_code == 204
    assert user.status == UserStatus.ACTIVE.value
    assert user.invitation_accepted_at is not None
    assert db.commit.call_count == 3

    monkeypatch.setattr(
        auth_router, "consume_action_token", Mock(side_effect=ActionTokenInvalid("bad"))
    )
    with pytest.raises(HTTPException) as recovery_invalid:
        auth_router.complete_recovery(payload, _request(), db)
    with pytest.raises(HTTPException) as invitation_invalid:
        auth_router.complete_invitation(payload, _request(), db)
    assert recovery_invalid.value.status_code == 400
    assert invitation_invalid.value.status_code == 400
    assert db.rollback.call_count == 2


def test_invitation_completion_records_attempt_and_commits_success_with_activation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user(status=UserStatus.PENDING)
    action = SimpleNamespace(user_id=user.id)
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    events: list[str] = []
    monkeypatch.setattr(auth_router, "consume_action_token", Mock(return_value=action))
    monkeypatch.setattr(auth_router, "replace_password", Mock())
    monkeypatch.setattr(
        auth_router,
        "begin_invitation_acceptance",
        lambda *_args: events.append("attempt") or uuid7(),
    )
    monkeypatch.setattr(
        auth_router,
        "append_invitation_acceptance_success",
        lambda *_args: events.append("success"),
    )
    monkeypatch.setattr(
        auth_router,
        "record_invitation_acceptance_failure",
        lambda *_args, **_kwargs: events.append("failure"),
    )
    db.get.return_value = user
    db.commit.side_effect = lambda: events.append("commit")

    assert auth_router.complete_invitation(payload, _request(), db).status_code == 204
    assert user.status == UserStatus.ACTIVE.value
    assert events == ["commit", "attempt", "success", "commit"]


def test_invitation_completion_records_attempt_and_failure_for_an_invalid_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    events: list[str] = []
    monkeypatch.setattr(
        auth_router,
        "begin_invitation_acceptance",
        lambda *_args: events.append("attempt") or uuid7(),
    )
    monkeypatch.setattr(
        auth_router,
        "record_invitation_acceptance_failure",
        lambda *_args, **_kwargs: events.append("failure"),
    )
    monkeypatch.setattr(
        auth_router,
        "consume_action_token",
        Mock(side_effect=ActionTokenInvalid("invalid")),
    )

    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(payload, _request(), db)

    assert error.value.status_code == 400
    assert events == ["attempt", "failure"]


def test_invitation_completion_is_limited_before_durable_audit_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Anonymous token guesses cannot create unbounded security-event rows."""

    db = Mock(spec=Session)
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    admission = Mock(return_value=False)
    begin = Mock(return_value=uuid7())
    consume = Mock(side_effect=ActionTokenInvalid("invalid"))
    monkeypatch.setattr(auth_router, "invitation_completion_permitted", admission, raising=False)
    monkeypatch.setattr(auth_router, "begin_invitation_acceptance", begin)
    monkeypatch.setattr(auth_router, "record_invitation_acceptance_failure", Mock())
    monkeypatch.setattr(auth_router, "consume_action_token", consume)

    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(payload, _request(), db)

    assert error.value.status_code == 429
    admission.assert_called_once_with(db, source="127.0.0.1", enforce_rate_limit=True)
    begin.assert_not_called()
    consume.assert_not_called()
    db.commit.assert_called_once()


def test_invitation_completion_fails_closed_when_admission_persistence_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.commit.side_effect = SQLAlchemyError("database unavailable")
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    begin = Mock(return_value=uuid7())
    consume = Mock()
    monkeypatch.setattr(auth_router, "begin_invitation_acceptance", begin)
    monkeypatch.setattr(auth_router, "consume_action_token", consume)

    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(payload, _request(), db)

    assert error.value.status_code == 503
    begin.assert_not_called()
    consume.assert_not_called()
    db.rollback.assert_called_once()


def test_invitation_completion_records_failure_when_activation_cannot_commit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user(status=UserStatus.PENDING)
    action = SimpleNamespace(user_id=user.id)
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    events: list[str] = []
    monkeypatch.setattr(auth_router, "consume_action_token", Mock(return_value=action))
    monkeypatch.setattr(auth_router, "replace_password", Mock())
    monkeypatch.setattr(
        auth_router,
        "begin_invitation_acceptance",
        lambda *_args: events.append("attempt") or uuid7(),
    )
    monkeypatch.setattr(
        auth_router,
        "append_invitation_acceptance_success",
        lambda *_args: events.append("success"),
    )
    monkeypatch.setattr(
        auth_router,
        "record_invitation_acceptance_failure",
        lambda *_args, **_kwargs: events.append("failure"),
    )
    db.get.return_value = user
    db.commit.side_effect = [None, SQLAlchemyError("database unavailable")]

    with pytest.raises(HTTPException) as error:
        auth_router.complete_invitation(payload, _request(), db)

    assert error.value.status_code == 503
    assert events == ["attempt", "success", "failure"]
    db.rollback.assert_called_once()


def test_recovery_completion_rejects_a_disabled_user_after_consuming_the_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user()
    user.status = UserStatus.DISABLED.value
    action = SimpleNamespace(user_id=user.id)
    payload = ActionTokenCompleteRequest(token="x" * 32, password="new sufficiently long password")
    monkeypatch.setattr(auth_router, "consume_action_token", Mock(return_value=action))
    db.get.return_value = user

    with pytest.raises(HTTPException) as error:
        auth_router.complete_recovery(payload, _request(), db)

    assert error.value.status_code == 400
    db.rollback.assert_called_once()


def test_recovery_request_has_identical_success_response_for_known_and_unknown_users(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.info = {}
    user = _user()
    payload = RecoveryRequest(identifier=" Person@Example.Test ")
    db.scalar.return_value = user
    monkeypatch.setattr(auth_router, "smtp_delivery_enabled", lambda: True)
    monkeypatch.setattr(auth_router, "recovery_request_permitted", lambda *_args, **_kwargs: True)
    issue = Mock(return_value="recovery-token")
    queue = Mock()
    monkeypatch.setattr(auth_router.recovery, "issue_action_token", issue)
    monkeypatch.setattr(auth_router.recovery, "queue_action_delivery", queue)

    assert auth_router.request_recovery(payload, _request(), db).status_code == 204
    issue.assert_called_once_with(db, user.id, ActionTokenPurpose.RECOVERY)
    queue.assert_called_once_with(db, user.id, ActionTokenPurpose.RECOVERY, "recovery-token")
    db.scalar.return_value = None
    assert auth_router.request_recovery(payload, _request(), db).status_code == 204
    assert issue.call_count == 1
    assert db.commit.call_count == 2


def test_current_identity_validates_one_transport_and_cookie_mutation_csrf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.info = {}
    user = _user()
    session_id = uuid7()
    claims = {"sub": str(user.id), "sid": str(session_id)}
    monkeypatch.setattr(dependencies, "decode_token", lambda *_args: claims)
    monkeypatch.setattr(dependencies, "validate_access_session", lambda *_args, **_kwargs: user)
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


def test_recovery_request_hides_an_expired_account_without_issuing_a_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user()
    user.expires_at = datetime.now(UTC)
    db.scalar.return_value = user
    issue = Mock(return_value="recovery-token")
    monkeypatch.setattr(auth_router, "smtp_delivery_enabled", lambda: True)
    monkeypatch.setattr(auth_router, "recovery_request_permitted", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(auth_router.recovery, "issue_action_token", issue)
    monkeypatch.setattr(auth_router.recovery, "queue_action_delivery", Mock())

    response = auth_router.request_recovery(RecoveryRequest(identifier=user.email), _request(), db)

    assert response.status_code == 204
    issue.assert_not_called()
    db.commit.assert_called_once()


def test_recovery_request_hides_an_expiry_race_after_rate_limit_admission(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    user = _user()
    db.scalar.return_value = user
    monkeypatch.setattr(auth_router, "smtp_delivery_enabled", lambda: True)
    monkeypatch.setattr(auth_router, "recovery_request_permitted", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(
        auth_router.recovery,
        "issue_action_token",
        Mock(side_effect=ActionTokenInvalid("recipient expired")),
    )

    response = auth_router.request_recovery(RecoveryRequest(identifier=user.email), _request(), db)

    assert response.status_code == 204
    db.commit.assert_called_once()
    db.rollback.assert_not_called()


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
