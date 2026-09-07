from datetime import UTC, datetime
from unittest.mock import Mock
from uuid import uuid7

import pytest
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

import app.systems.auth.router as auth_router
import app.systems.users.router as users_router
import app.systems.users.service as users_service
from app.core.integrations.supabase import (
    SupabaseAdminClient,
    SupabaseAdminError,
    SupabaseAuthUser,
)
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import Role, User, UserRole, UserStatus
from app.systems.users.schemas import UserCreate, UserUpdate
from app.systems.users.service import (
    InvitationConflict,
    InvitationError,
)
from app.systems.users.service import (
    invite_user as invite_user_service,
)


def role(name: str = UserRole.MEMBER, *, deleted: bool = False) -> Role:
    result = Role(role=name, permissions={}, is_deleted=deleted)
    result.id = uuid7()
    return result


def profile(user_id, assigned_role: Role, *, status: str = UserStatus.PENDING.value) -> User:
    return User(
        id=user_id,
        email="invited@example.com",
        username=f"auth_{user_id.hex}",
        status=status,
        role_id=assigned_role.id,
        role=assigned_role,
        is_deleted=False,
    )


def invitation(role_id=None) -> InvitationCreate:
    return InvitationCreate(
        email=" Invited@Example.com ",
        username=" New_User ",
        role_id=role_id,
    )


def auth_client(auth_id=None) -> Mock:
    client = Mock(spec=SupabaseAdminClient)
    client.invite_user.return_value = SupabaseAuthUser(
        auth_id or uuid7(), "invited@example.com"
    )
    return client


@pytest.fixture(autouse=True)
def committed_security_events(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(users_service, "append_committed_security_event", lambda _payload: None)
    monkeypatch.setattr(users_router, "_security_event", lambda *_args, **_kwargs: None)


def invite_user(db: Mock, payload: InvitationCreate, *, client: Mock) -> User:
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    side_effect = db.scalar.side_effect
    if side_effect is not None:
        existing_values = list(side_effect)
        values = [admin_role, admin, *existing_values]
        if len(existing_values) >= 2 and existing_values[1] is None:
            values = [
                admin_role,
                admin,
                existing_values[0],
                existing_values[1],
                admin_role,
                admin,
                *existing_values[2:],
            ]
        db.scalar.side_effect = values
    else:
        db.scalar.side_effect = [admin_role, admin, db.scalar.return_value]
    return invite_user_service(db, payload, client=client, actor_id=admin.id)


def test_application_invitation_requires_an_explicit_actor() -> None:
    with pytest.raises(InvitationError, match="actor is required"):
        invite_user_service(Mock(spec=Session), invitation(), client=auth_client())


def test_invitation_finalizes_trigger_created_pending_profile_and_commits() -> None:
    assigned_role = role()
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None, assigned_role, pending_profile]

    result = invite_user(db, invitation(assigned_role.id), client=client)

    assert result is pending_profile
    assert pending_profile.email == "invited@example.com"
    assert pending_profile.username == "new_user"
    assert pending_profile.status == UserStatus.PENDING.value
    assert isinstance(pending_profile.invitation_sent_at, datetime)
    assert pending_profile.invitation_sent_at.tzinfo is not None
    assert pending_profile.invitation_accepted_at is None
    assert pending_profile.is_deleted is False
    assert pending_profile.deleted_at is None
    assert pending_profile.role is assigned_role
    client.invite_user.assert_called_once_with("invited@example.com", "new_user")
    client.delete_user.assert_not_called()
    db.commit.assert_called_once()
    db.refresh.assert_called_once_with(pending_profile)


def test_bootstrap_loser_keeps_trigger_profile_at_member_role_and_records_partial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    member_role = role()
    admin_role = role(UserRole.ADMIN)
    auth_id = uuid7()
    pending_profile = profile(auth_id, member_role)
    pending_profile.email = "bootstrap-two@example.com"
    client = auth_client(auth_id)
    client.invite_user.return_value = SupabaseAuthUser(auth_id, pending_profile.email)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin_role,
        member_role,
        None,
        member_role,
        admin_role,
        1,
    ]
    event_writer = Mock()
    monkeypatch.setattr(users_service, "append_committed_security_event", event_writer)

    with pytest.raises(InvitationError, match="administrator reservation"):
        invite_user_service(
            database,
            InvitationCreate(
                email=pending_profile.email,
                username="bootstrap-two",
                role_id=admin_role.id,
            ),
            client=client,
            bootstrap=True,
        )

    assert pending_profile.role_id == member_role.id
    assert pending_profile.role is member_role
    assert pending_profile.status == UserStatus.PENDING.value
    assert pending_profile.invitation_sent_at is None
    assert database.commit.called is False
    client.delete_user.assert_not_called()
    client.disable_user.assert_not_called()
    events = [call.args[0] for call in event_writer.call_args_list]
    assert [event.outcome.value for event in events] == ["attempt", "partial"]
    assert len({event.operation_id for event in events}) == 1


def test_bootstrap_winner_assigns_the_admin_role_after_mutex_recheck() -> None:
    member_role = role()
    admin_role = role(UserRole.ADMIN)
    auth_id = uuid7()
    pending_profile = profile(auth_id, member_role)
    client = auth_client(auth_id)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin_role,
        member_role,
        None,
        member_role,
        admin_role,
        0,
        pending_profile,
    ]

    result = invite_user_service(
        database,
        InvitationCreate(
            email="invited@example.com",
            username="bootstrap-admin",
            role_id=admin_role.id,
        ),
        client=client,
        bootstrap=True,
    )

    assert result is pending_profile
    assert pending_profile.role_id == admin_role.id
    assert pending_profile.role is admin_role
    assert pending_profile.status == UserStatus.PENDING.value
    assert pending_profile.invitation_sent_at is not None
    database.commit.assert_called_once()


def test_invitation_leaves_auth_identity_when_trigger_profile_is_missing() -> None:
    assigned_role = role()
    auth_id = uuid7()
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None, assigned_role, None]

    with pytest.raises(InvitationError, match="finalize"):
        invite_user(db, invitation(assigned_role.id), client=client)

    assert db.rollback.call_count >= 2
    client.delete_user.assert_not_called()
    db.commit.assert_not_called()


def test_invitation_rejects_local_duplicate_before_calling_supabase() -> None:
    assigned_role = role()
    duplicate = profile(uuid7(), assigned_role)
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, duplicate]

    with pytest.raises(InvitationConflict, match="already in use"):
        invite_user(db, invitation(assigned_role.id), client=client)

    client.invite_user.assert_not_called()
    db.commit.assert_not_called()


def test_invitation_rejects_a_stranded_pending_auth_profile_without_deleting_auth() -> None:
    assigned_role = role()
    stale_profile = profile(uuid7(), assigned_role)
    stale_profile.email = "invited@example.com"
    stale_profile.username = f"auth_{stale_profile.id.hex}"
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, stale_profile]

    with pytest.raises(InvitationConflict, match="already in use"):
        invite_user(db, invitation(assigned_role.id), client=client)

    client.delete_user.assert_not_called()
    client.invite_user.assert_not_called()


def test_invitation_fails_safely_when_pending_profile_reconciliation_fails() -> None:
    assigned_role = role()
    stale_profile = profile(uuid7(), assigned_role)
    stale_profile.email = "invited@example.com"
    stale_profile.username = f"auth_{stale_profile.id.hex}"
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, stale_profile]

    with pytest.raises(InvitationConflict, match="already in use"):
        invite_user(db, invitation(assigned_role.id), client=client)

    client.invite_user.assert_not_called()


def test_pending_invitation_can_only_be_activated_by_verified_acceptance_and_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    accept = getattr(users_service, "accept_verified_invitation", None)
    assert callable(accept), "accept_verified_invitation is not implemented"

    assigned_role = role()
    pending_profile = profile(uuid7(), assigned_role)
    pending_profile.invitation_sent_at = datetime.now(UTC)
    db = Mock(spec=Session)
    admin_role = role(UserRole.ADMIN)
    db.scalar.side_effect = [
        admin_role,
        pending_profile,
        assigned_role,
        admin_role,
        pending_profile,
        assigned_role,
    ]

    first = accept(
        db,
        pending_profile.id,
        verified_email=pending_profile.email,
        verified_identity=pending_profile.id,
    )
    accepted_at = first.invitation_accepted_at
    second = accept(
        db,
        pending_profile.id,
        verified_email=pending_profile.email,
        verified_identity=pending_profile.id,
    )

    assert first is pending_profile
    assert second is pending_profile
    assert pending_profile.status == UserStatus.ACTIVE.value
    assert accepted_at is not None
    assert pending_profile.invitation_accepted_at == accepted_at
    assert db.commit.call_count == 1


def test_resend_invitation_reuses_auth_identity_and_releases_preflight_locks() -> None:
    assigned_role = role()
    target = profile(uuid7(), assigned_role)
    target.invitation_sent_at = datetime.now(UTC)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin_role,
        admin,
        target,
        assigned_role,
        admin_role,
        admin,
        target,
        assigned_role,
    ]
    database.in_transaction.return_value = True

    def release_transaction() -> None:
        database.in_transaction.return_value = False

    database.rollback.side_effect = release_transaction

    def resend(email: str) -> None:
        assert email == target.email
        assert database.in_transaction() is False

    client.resend_invitation.side_effect = resend

    result = users_service.resend_invitation(
        database,
        target.id,
        actor_id=admin.id,
        client=client,
    )

    assert result is target
    client.resend_invitation.assert_called_once_with(target.email)
    client.delete_user.assert_not_called()


def test_resend_invitation_rejects_profile_drift_without_overwriting_it() -> None:
    assigned_role = role()
    target = profile(uuid7(), assigned_role)
    target.invitation_sent_at = datetime.now(UTC)
    changed_target = profile(target.id, assigned_role)
    changed_target.invitation_sent_at = datetime.now(UTC)
    changed_target.invitation_accepted_at = datetime.now(UTC)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin_role,
        admin,
        target,
        assigned_role,
        admin_role,
        admin,
        changed_target,
        assigned_role,
    ]

    client.resend_invitation.return_value = None

    with pytest.raises(InvitationError, match="changed"):
        users_service.resend_invitation(
            database,
            target.id,
            actor_id=admin.id,
            client=client,
        )

    assert changed_target.invitation_accepted_at is not None
    database.commit.assert_not_called()
    client.delete_user.assert_not_called()


def test_resend_invitation_rechecks_that_its_role_is_still_active() -> None:
    assigned_role = role()
    target = profile(uuid7(), assigned_role)
    target.invitation_sent_at = datetime.now(UTC)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin_role,
        admin,
        target,
        assigned_role,
        admin_role,
        admin,
        target,
        None,
    ]
    client = Mock(spec=SupabaseAdminClient)

    with pytest.raises(InvitationError, match="active"):
        users_service.resend_invitation(
            database,
            target.id,
            actor_id=admin.id,
            client=client,
        )

    client.resend_invitation.assert_called_once_with(target.email)
    database.commit.assert_not_called()


def test_resend_invitation_records_correlated_provider_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    target = profile(uuid7(), assigned_role)
    target.invitation_sent_at = datetime.now(UTC)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    client.resend_invitation.side_effect = SupabaseAdminError("upstream", status_code=503)
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin_role, admin, target, assigned_role]
    event_writer = Mock()
    monkeypatch.setattr(users_service, "append_committed_security_event", event_writer)

    with pytest.raises(InvitationError, match="resend invitation"):
        users_service.resend_invitation(
            database,
            target.id,
            actor_id=admin.id,
            client=client,
        )

    events = [call.args[0] for call in event_writer.call_args_list]
    assert [event.outcome.value for event in events] == ["attempt", "failure"]
    assert len({event.operation_id for event in events}) == 1
    database.commit.assert_not_called()


@pytest.mark.parametrize("status_code", [409, 422])
def test_invitation_maps_supabase_duplicate_to_conflict(status_code: int) -> None:
    assigned_role = role()
    client = auth_client()
    client.invite_user.side_effect = SupabaseAdminError("upstream", status_code=status_code)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None]

    with pytest.raises(InvitationConflict, match="already in use"):
        invite_user(db, invitation(assigned_role.id), client=client)


def test_invitation_maps_other_supabase_error_to_safe_error() -> None:
    assigned_role = role()
    client = auth_client()
    client.invite_user.side_effect = SupabaseAdminError("upstream", status_code=503)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None]

    with pytest.raises(InvitationError, match="send invitation"):
        invite_user(db, invitation(assigned_role.id), client=client)


def test_invitation_records_durable_attempt_and_provider_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    client = auth_client()
    client.invite_user.side_effect = SupabaseAdminError("upstream", status_code=503)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None]
    event_writer = Mock()
    monkeypatch.setattr(users_service, "append_committed_security_event", event_writer)

    with pytest.raises(InvitationError):
        invite_user(db, invitation(assigned_role.id), client=client)

    events = [call.args[0] for call in event_writer.call_args_list]
    assert [event.outcome.value for event in events] == ["attempt", "failure"]
    assert len({event.operation_id for event in events}) == 1


def test_invitation_releases_preflight_locks_before_auth_http() -> None:
    assigned_role = role()
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None, assigned_role, pending_profile]
    db.in_transaction.return_value = True

    def release_transaction() -> None:
        db.in_transaction.return_value = False

    db.rollback.side_effect = release_transaction

    def invite(_email: str, _username: str) -> SupabaseAuthUser:
        assert db.in_transaction() is False
        return SupabaseAuthUser(auth_id, "invited@example.com")

    client.invite_user.side_effect = invite

    result = invite_user(db, invitation(assigned_role.id), client=client)

    assert result is pending_profile


def test_invitation_does_not_overwrite_a_trigger_profile_that_drifted() -> None:
    assigned_role = role()
    auth_id = uuid7()
    drifted_profile = profile(auth_id, assigned_role)
    drifted_profile.email = "changed@example.com"
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [
        admin_role,
        admin,
        assigned_role,
        None,
        admin_role,
        admin,
        assigned_role,
        drifted_profile,
    ]

    with pytest.raises(InvitationError, match="profile changed"):
        invite_user_service(
            db,
            invitation(assigned_role.id),
            client=client,
            actor_id=admin.id,
        )

    assert drifted_profile.email == "changed@example.com"
    assert drifted_profile.username == f"auth_{auth_id.hex}"
    db.commit.assert_not_called()
    client.delete_user.assert_not_called()


def test_invitation_does_not_assign_a_role_that_drifted_during_auth_http() -> None:
    assigned_role = role()
    changed_role = role()
    changed_role.id = assigned_role.id
    changed_role.permissions = {"records.read": True}
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [
        admin_role,
        admin,
        assigned_role,
        None,
        admin_role,
        admin,
        changed_role,
        pending_profile,
    ]

    with pytest.raises(InvitationError, match="role changed"):
        invite_user_service(
            db,
            invitation(assigned_role.id),
            client=client,
            actor_id=admin.id,
        )

    assert pending_profile.role_id == assigned_role.id
    assert pending_profile.status == UserStatus.PENDING.value
    db.commit.assert_not_called()
    client.delete_user.assert_not_called()


def test_invitation_rejects_inactive_or_missing_role_without_external_call() -> None:
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.return_value = None

    with pytest.raises(InvitationError, match="Role is not active"):
        invite_user(db, invitation(uuid7()), client=client)

    client.invite_user.assert_not_called()


def test_invitation_requires_an_active_default_member_role() -> None:
    client = auth_client()
    db = Mock(spec=Session)
    db.scalar.return_value = None

    with pytest.raises(InvitationError, match="Default member role"):
        invite_user(db, invitation(), client=client)

    client.invite_user.assert_not_called()


@pytest.mark.parametrize(
    "commit_error",
    [IntegrityError("stmt", {}, Exception()), SQLAlchemyError()],
)
def test_invitation_rolls_back_without_destructive_compensation(commit_error: Exception) -> None:
    assigned_role = role()
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    db = Mock(spec=Session)
    db.scalar.side_effect = [assigned_role, None, assigned_role, pending_profile]
    db.commit.side_effect = commit_error

    expected = InvitationConflict if isinstance(commit_error, IntegrityError) else InvitationError
    with pytest.raises(expected):
        invite_user(db, invitation(assigned_role.id), client=client)

    assert db.rollback.call_count >= 2
    client.delete_user.assert_not_called()


def test_failed_invitation_compensation_is_observable_and_correlated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    auth_id = uuid7()
    pending_profile = profile(auth_id, assigned_role)
    client = auth_client(auth_id)
    database = Mock(spec=Session)
    database.scalar.side_effect = [assigned_role, None, pending_profile]
    database.commit.side_effect = SQLAlchemyError("local finalization failed")
    event_writer = Mock()
    monkeypatch.setattr(users_service, "append_committed_security_event", event_writer)

    with pytest.raises(InvitationError):
        invite_user(database, invitation(assigned_role.id), client=client)

    events = [call.args[0] for call in event_writer.call_args_list]
    assert events
    operation_ids = {event.operation_id for event in events}
    outcomes = {getattr(event.outcome, "value", event.outcome) for event in events}
    assert len(operation_ids) == 1
    assert "attempt" in outcomes
    assert "partial" in outcomes
    client.delete_user.assert_not_called()


def test_router_create_user_returns_invited_profile(monkeypatch: pytest.MonkeyPatch) -> None:
    assigned_role = role()
    invited = profile(uuid7(), assigned_role, status=UserStatus.ACTIVE.value)
    monkeypatch.setattr(users_router, "invite_user", lambda *_args, **_kwargs: invited)

    result = users_router.create_user(
        UserCreate(email="person@example.com", username="person", role_id=assigned_role.id),
        invited,
        Mock(spec=Session),
    )

    assert result is invited


@pytest.mark.parametrize(
    ("error", "status_code"),
    [
        (InvitationConflict("duplicate"), 409),
        (InvitationError("upstream"), 502),
    ],
)
def test_router_maps_invitation_errors_to_api_responses(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    status_code: int,
) -> None:
    monkeypatch.setattr(users_router, "invite_user", Mock(side_effect=error))

    with pytest.raises(users_router.HTTPException) as raised:
        users_router.create_user(
            UserCreate(email="person@example.com", username="person"),
            Mock(),
            Mock(spec=Session),
        )

    assert raised.value.status_code == status_code


def test_resend_route_returns_the_refreshed_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = profile(uuid7(), role())
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    monkeypatch.setattr(auth_router, "resend_invitation", lambda *_args, **_kwargs: target)

    result = auth_router.resend(target.id, admin, Mock(spec=Session))

    assert result is target


@pytest.mark.parametrize(
    ("error", "status_code"),
    [(InvitationConflict("duplicate"), 409), (InvitationError("upstream"), 502)],
)
def test_resend_route_maps_invitation_errors(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    status_code: int,
) -> None:
    monkeypatch.setattr(auth_router, "resend_invitation", Mock(side_effect=error))
    target_id = uuid7()
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)

    with pytest.raises(auth_router.HTTPException) as raised:
        auth_router.resend(target_id, admin, Mock(spec=Session))

    assert raised.value.status_code == status_code


def test_acceptance_route_returns_the_finalized_profile(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = profile(uuid7(), role())
    identity = auth_router.VerifiedPendingIdentity(subject=target.id, email=target.email)
    monkeypatch.setattr(
        auth_router,
        "accept_verified_invitation",
        lambda *_args, **_kwargs: target,
    )

    result = auth_router.accept_invitation(identity, Mock(spec=Session))

    assert result is target


@pytest.mark.parametrize(
    ("error", "status_code"),
    [(InvitationConflict("conflict"), 409), (InvitationError("invalid"), 409)],
)
def test_acceptance_route_maps_invitation_errors(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    status_code: int,
) -> None:
    monkeypatch.setattr(auth_router, "accept_verified_invitation", Mock(side_effect=error))
    identity = auth_router.VerifiedPendingIdentity(subject=uuid7(), email="person@example.com")

    with pytest.raises(auth_router.HTTPException) as raised:
        auth_router.accept_invitation(identity, Mock(spec=Session))

    assert raised.value.status_code == status_code


def test_activation_commits_local_status_only_after_auth_enable_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.DISABLED.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    db = Mock(spec=Session)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [admin.role, admin, user, admin.role, admin, user]

    result = users_router.update_user(user.id, UserUpdate(status=UserStatus.ACTIVE), admin, db)

    assert result is user
    assert user.status == UserStatus.ACTIVE.value
    client.enable_user.assert_called_once_with(user.id)
    db.commit.assert_called_once()


def test_admin_activation_does_not_activate_a_pending_invitation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.PENDING.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    db = Mock(spec=Session)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [admin.role, admin, user]

    with pytest.raises(users_router.HTTPException) as error:
        users_router.update_user(
            user.id,
            UserUpdate(status=UserStatus.ACTIVE),
            admin,
            db,
        )

    assert error.value.status_code == 409
    assert user.status == UserStatus.PENDING.value
    client.enable_user.assert_not_called()
    db.commit.assert_not_called()


def test_activation_fails_closed_when_auth_enable_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.DISABLED.value)
    client = Mock(spec=SupabaseAdminClient)
    client.enable_user.side_effect = SupabaseAdminError("upstream")
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    db = Mock(spec=Session)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [admin.role, admin, user]

    with pytest.raises(users_router.HTTPException) as error:
        users_router.update_user(user.id, UserUpdate(status=UserStatus.ACTIVE), admin, db)

    assert error.value.status_code == 503
    assert user.status == UserStatus.DISABLED.value
    db.commit.assert_not_called()


def test_activation_finalization_drift_does_not_disable_auth_after_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.DISABLED.value)
    drifted = profile(user.id, assigned_role, status=UserStatus.DISABLED.value)
    drifted.username = "changed_while_blocked"
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin.role, admin, user, admin.role, admin, drifted]

    with pytest.raises(users_router.HTTPException) as error:
        users_router.update_user(user.id, UserUpdate(status=UserStatus.ACTIVE), admin, database)

    assert error.value.status_code == 409
    client.enable_user.assert_called_once_with(user.id)
    client.disable_user.assert_not_called()


def test_restore_finalization_drift_does_not_disable_auth_after_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role, status=UserStatus.DISABLED.value)
    user.is_deleted = True
    user.deleted_at = datetime.now(UTC)
    drifted = profile(user.id, assigned_role, status=UserStatus.ACTIVE.value)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin.role,
        admin,
        user,
        assigned_role,
        admin.role,
        admin,
        drifted,
    ]

    with pytest.raises(users_router.HTTPException) as error:
        users_router.restore_user(user.id, admin, database)

    assert error.value.status_code == 409
    client.enable_user.assert_called_once_with(user.id)
    client.disable_user.assert_not_called()


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_local_first_disable_provider_failure_records_partial_without_compensation(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role)
    client = Mock(spec=SupabaseAdminClient)
    client.disable_user.side_effect = SupabaseAdminError("upstream")
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    db = Mock(spec=Session)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    db.scalar.side_effect = [admin.role, admin, user]
    event_writer = Mock()
    monkeypatch.setattr(users_router, "_security_event", event_writer)

    with pytest.raises(users_router.HTTPException) as error:
        if operation == "disable":
            users_router.update_user(user.id, UserUpdate(status=UserStatus.DISABLED), admin, db)
        else:
            users_router.delete_user(user.id, admin, db)

    assert error.value.status_code == 503
    assert user.status == UserStatus.DISABLED.value
    assert user.tokens_valid_after is not None
    db.commit.assert_called_once()
    client.disable_user.assert_called_once_with(user.id)
    client.enable_user.assert_not_called()
    outcomes = [call.kwargs["outcome"].value for call in event_writer.call_args_list]
    operation_ids = {call.kwargs["operation_id"] for call in event_writer.call_args_list}
    assert outcomes == ["attempt", "partial"]
    assert len(operation_ids) == 1


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_local_first_disable_commit_failure_remains_failure_without_auth_call(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin.role, admin, user]
    database.commit.side_effect = SQLAlchemyError("local failure")
    event_writer = Mock()
    monkeypatch.setattr(users_router, "_security_event", event_writer)

    with pytest.raises(users_router.HTTPException) as error:
        if operation == "disable":
            users_router.update_user(
                user.id,
                UserUpdate(status=UserStatus.DISABLED),
                admin,
                database,
            )
        else:
            users_router.delete_user(user.id, admin, database)

    assert error.value.status_code == 503
    client.disable_user.assert_not_called()
    client.enable_user.assert_not_called()
    outcomes = [call.kwargs["outcome"].value for call in event_writer.call_args_list]
    operation_ids = {call.kwargs["operation_id"] for call in event_writer.call_args_list}
    assert outcomes == ["attempt", "failure"]
    assert len(operation_ids) == 1


@pytest.mark.parametrize("operation", ["disable", "delete"])
def test_disable_and_delete_advance_token_cutoff_before_remote_auth_call(
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    database = Mock(spec=Session)
    database.scalar.side_effect = [admin.role, admin, user]
    calls: list[str] = []

    def commit() -> None:
        calls.append("commit")

    def disable_user(user_id) -> None:
        calls.append("disable_auth")
        assert user_id == user.id

    database.commit.side_effect = commit
    client.disable_user.side_effect = disable_user

    if operation == "disable":
        result = users_router.update_user(
            user.id,
            UserUpdate(status=UserStatus.DISABLED),
            admin,
            database,
        )
    else:
        result = users_router.delete_user(user.id, admin, database)

    assert result is not None
    assert user.tokens_valid_after is not None
    assert calls == ["commit", "disable_auth"]


def test_restore_releases_the_database_transaction_before_auth_enable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assigned_role = role()
    user = profile(uuid7(), assigned_role)
    user.is_deleted = True
    user.deleted_at = datetime.now(UTC)
    admin = profile(uuid7(), role(UserRole.ADMIN), status=UserStatus.ACTIVE.value)
    client = Mock(spec=SupabaseAdminClient)
    monkeypatch.setattr(users_router, "SupabaseAdminClient", lambda: client)
    database = Mock(spec=Session)
    database.scalar.side_effect = [
        admin.role,
        admin,
        user,
        assigned_role,
        admin.role,
        admin,
        user,
        assigned_role,
    ]
    database.in_transaction.return_value = True

    def commit() -> None:
        database.in_transaction.return_value = False

    database.rollback.side_effect = commit

    def enable_user(user_id) -> None:
        assert user_id == user.id
        assert database.in_transaction() is False

    database.commit.side_effect = commit
    client.enable_user.side_effect = enable_user

    result = users_router.restore_user(user.id, admin, database)

    assert result is user
    assert user.is_deleted is False
    assert user.status == UserStatus.ACTIVE.value
