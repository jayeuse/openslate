"""Behavior coverage for user administration after local Identity cutover."""

from unittest.mock import Mock

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import ProviderUser, SupabaseAuthUnavailable
from app.systems.access.identity.models import IdentityMfaObservation
from app.systems.access.policy.models import GroupMember
from app.systems.access.users.coordination import (
    InvitationConflict,
    InvitationError,
    ProfileValidationError,
)
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.access.users.schemas import InvitationCreate
from app.systems.manage.audit.models import SecurityEvent, SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from tests.users.user_support import local_user


def _invitation() -> InvitationCreate:
    return InvitationCreate(email="person@example.com", username="person")


pytestmark = pytest.mark.usefixtures("local_identity_security_events")


def test_invitation_requires_actor_outside_bootstrap() -> None:
    with pytest.raises(InvitationError, match="actor is required"):
        user_service.invite_user(Mock(spec=Session), _invitation())


def test_invitation_rejects_duplicate_email_or_username() -> None:
    db = Mock(spec=Session)
    db.scalar.side_effect = [local_user()[0]]

    with pytest.raises(InvitationConflict):
        user_service.invite_user(db, _invitation(), bootstrap=True)

    db.commit.assert_not_called()


def test_invitation_keeps_duplicate_conflict_when_failure_audit_cannot_persist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    db.scalar.side_effect = [local_user()[0]]
    monkeypatch.setattr(
        user_service,
        "_security_event",
        Mock(side_effect=InvitationError("audit unavailable")),
    )

    with pytest.raises(InvitationConflict):
        user_service.invite_user(db, _invitation(), bootstrap=True)

    db.rollback.assert_called_once()


def _initial_invitation(monkeypatch: pytest.MonkeyPatch):
    db = Mock(spec=Session)
    db.scalar.side_effect = [None]
    provider = Mock()
    outcomes = []
    monkeypatch.setattr(
        user_service,
        "_security_event",
        lambda *, outcome, **_kwargs: outcomes.append(outcome.value),
    )
    monkeypatch.setattr(user_service, "append_security_event", Mock())

    def profile():
        return next(
            call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], User)
        )

    def assign_identity():
        profile().id = uuid7()

    def create(email, local_id, operation_id):
        assert db.commit.call_count == 1
        user = ProviderUser(
            uuid7(),
            None,
            email,
            {
                "openslate_user_id": str(local_id),
                "openslate_invitation_operation_id": str(operation_id),
            },
        )
        provider_id.append(user.id)
        return user

    def send(email):
        return ProviderUser(provider_id[0], None, email)

    provider_id = []

    provider.admin_create_invitation_user.side_effect = create
    provider.admin_send_invitation.side_effect = send
    db.flush.side_effect = assign_identity
    monkeypatch.setattr(user_service, "get_user", lambda *_args: profile())
    return db, provider, outcomes


def test_initial_reservation_commit_failure_never_calls_provider(monkeypatch):
    db, provider, outcomes = _initial_invitation(monkeypatch)
    db.commit.side_effect = SQLAlchemyError("commit unavailable")
    with pytest.raises(InvitationConflict):
        user_service.invite_user(db, _invitation(), bootstrap=True, client=provider)
    db.rollback.assert_called_once()
    provider.admin_create_invitation_user.assert_not_called()
    assert outcomes == ["failure"]


def test_email_invitation_commits_pending_reservation_then_correlated_success(monkeypatch):
    db, provider, outcomes = _initial_invitation(monkeypatch)
    result = user_service.invite_user(db, _invitation(), bootstrap=True, client=provider)
    assert result.status == UserStatus.PENDING.value
    assert result.supabase_user_id is not None
    membership = _added(db, Membership)[0]
    assert membership.invitation_sent_at is not None
    event = user_service.append_security_event.call_args.args[1]
    assert event.event_type == "user.invitation"
    assert event.outcome.value == "success"
    assert event.operation_id == membership.provider_invitation_operation_id
    assert event.subject_id == result.id
    assert db.commit.call_count == 2
    assert outcomes == []


@pytest.mark.parametrize("failure", ["audit", "binding_commit", "provider_delivery"])
def test_initial_delivery_failure_preserves_reservation_without_reporting_success(
    monkeypatch, failure
):
    db, provider, outcomes = _initial_invitation(monkeypatch)
    if failure == "audit":
        user_service.append_security_event.side_effect = SQLAlchemyError("audit unavailable")
    elif failure == "binding_commit":
        db.commit.side_effect = [None, SQLAlchemyError("commit unavailable")]
    else:
        provider.admin_send_invitation.side_effect = SupabaseAuthUnavailable("unavailable")
    with pytest.raises(InvitationError, match="Unable to send invitation"):
        user_service.invite_user(db, _invitation(), bootstrap=True, client=provider)
    db.rollback.assert_called_once()
    assert outcomes == ["failure"]
    assert db.commit.call_count == (2 if failure == "binding_commit" else 1)


# The module fixture replaces the failure-event writer; the event rows below need the real one.
SECURITY_EVENT = user_service._security_event
PROVIDER_ID = uuid7()


def _committed_events(monkeypatch: pytest.MonkeyPatch) -> list[SecurityEventIngestRequest]:
    """Keep the events that the real writer commits on its own session."""

    events: list[SecurityEventIngestRequest] = []
    monkeypatch.setattr(user_service, "_security_event", SECURITY_EVENT)
    monkeypatch.setattr(user_service, "append_committed_security_event", events.append)
    return events


def _added(db: Mock, kind: type) -> list:
    return [call.args[0] for call in db.add.call_args_list if isinstance(call.args[0], kind)]


def _actor_session(existing: User | None = None, groups: tuple = ()) -> tuple[Mock, User]:
    """A session for an administrator's invitation.

    The first read is the fresh administrator check and the second the email-or-username
    lookup; a later read returns the new profile, as ``get_user`` does. The listed groups
    are the active ones, and no MFA observation exists yet.
    """

    admin, membership = local_user(UserRole.ADMIN)
    db = Mock(spec=Session)
    reads: list[User | None] = [admin, existing]
    db.scalar.side_effect = lambda _statement: reads.pop(0) if reads else _added(db, User)[0]
    db.dirty = set()
    # The administrator's membership, then the active groups; the organization is bound.
    db.scalars.return_value.all.side_effect = [[membership], list(groups)]
    db.get.return_value = None

    def assign_identity() -> None:
        for profile in _added(db, User):
            profile.id = profile.id or uuid7()

    db.flush.side_effect = assign_identity
    return db, admin


def _provider(sent_to: list[str], *, email: str | None = None, operation: str | None = None):
    """The provider creates a marked identity and records whom each invitation goes to."""

    provider = Mock()

    def create(address: str, local_id: object, operation_id: object) -> ProviderUser:
        marker = {
            "openslate_user_id": str(local_id),
            "openslate_invitation_operation_id": operation or str(operation_id),
        }
        return ProviderUser(PROVIDER_ID, None, email or address, marker)

    def send(address: str) -> ProviderUser:
        sent_to.append(address)
        return ProviderUser(PROVIDER_ID, None, address)

    provider.admin_create_invitation_user.side_effect = create
    provider.admin_send_invitation.side_effect = send
    return provider


def test_an_invitation_reserves_the_profile_its_observation_and_its_memberships() -> None:
    group_id = uuid7()
    db, admin = _actor_session(groups=(group_id,))
    sent_to: list[str] = []
    payload = InvitationCreate(email="person@example.com", username="person", group_ids=[group_id])

    result = user_service.invite_user(db, payload, actor_id=admin.id, client=_provider(sent_to))

    assert (result.email, result.username) == ("person@example.com", "person")
    assert [(row.group_id, row.user_id, row.performed_by) for row in _added(db, GroupMember)] == [
        (group_id, result.id, admin.id)
    ]
    assert [row.user_id for row in _added(db, IdentityMfaObservation)] == [result.id]
    assert sent_to == ["person@example.com"]
    assert [
        (row.event_type, row.outcome, row.operation_id, row.actor_id, row.subject_id)
        for row in _added(db, SecurityEvent)
    ] == [
        (
            "user.invitation",
            SecurityEventOutcome.SUCCESS,
            _added(db, Membership)[0].provider_invitation_operation_id,
            admin.id,
            result.id,
        )
    ]


@pytest.mark.parametrize(
    ("failure", "error_type", "reserved"),
    [
        pytest.param("duplicate", InvitationConflict, False, id="duplicate-before-reservation"),
        pytest.param("reservation", InvitationConflict, True, id="reservation-commit-fails"),
        pytest.param("provider", InvitationError, True, id="provider-unavailable"),
        pytest.param("identity", InvitationError, True, id="provider-identity-does-not-match"),
    ],
)
def test_a_refused_invitation_records_one_failure_event_for_its_administrator(
    monkeypatch: pytest.MonkeyPatch, failure: str, error_type: type, reserved: bool
) -> None:
    events = _committed_events(monkeypatch)
    db, admin = _actor_session(existing=local_user()[0] if failure == "duplicate" else None)
    provider = _provider([], email="other@example.com" if failure == "identity" else None)
    if failure == "reservation":
        db.commit.side_effect = SQLAlchemyError("commit unavailable")
    if failure == "provider":
        provider.admin_create_invitation_user.side_effect = SupabaseAuthUnavailable("down")

    with pytest.raises(error_type):
        user_service.invite_user(db, _invitation(), actor_id=admin.id, client=provider)

    assert [
        (event.event_type, event.outcome, event.actor_id, event.subject_id) for event in events
    ] == [("user.invitation", SecurityEventOutcome.FAILURE, admin.id, None)]
    if reserved:
        # The failure belongs to the operation that the reservation carries.
        assert events[0].operation_id == _added(db, Membership)[0].provider_invitation_operation_id


@pytest.mark.parametrize(
    ("email", "operation"),
    [
        pytest.param("other@example.com", None, id="another-email"),
        pytest.param(None, str(uuid7()), id="another-invitation-operation"),
    ],
)
def test_an_invitation_binds_only_the_provider_identity_it_created(
    email: str | None, operation: str | None
) -> None:
    db, admin = _actor_session()
    sent_to: list[str] = []
    provider = _provider(sent_to, email=email, operation=operation)

    with pytest.raises(InvitationError):
        user_service.invite_user(db, _invitation(), actor_id=admin.id, client=provider)

    assert sent_to == []
    assert _added(db, User)[0].supabase_user_id is None


@pytest.mark.parametrize(
    "change",
    [
        pytest.param({"is_deleted": True}, id="deleted"),
        pytest.param({"status": UserStatus.DISABLED.value}, id="no-longer-pending"),
        pytest.param({"provider_invitation_operation_id": uuid7()}, id="another-operation"),
    ],
)
def test_an_invitation_that_stopped_pending_during_delivery_is_not_bound(
    change: dict[str, object],
) -> None:
    db, admin = _actor_session()

    def refresh(instance: User | Membership, **_options: object) -> None:
        # A revocation or deletion committed while the provider sent the email.
        for name, value in change.items():
            if name != "provider_invitation_operation_id" or isinstance(instance, Membership):
                setattr(instance, name, value)

    db.refresh.side_effect = refresh

    with pytest.raises(InvitationError):
        user_service.invite_user(db, _invitation(), actor_id=admin.id, client=_provider([]))

    reserved = _added(db, User)[0]
    assert (reserved.supabase_user_id, _added(db, Membership)[0].invitation_sent_at) == (None, None)


@pytest.mark.parametrize(
    ("role", "message"),
    [
        pytest.param(
            "admin",
            "Administrators have access everywhere and are not group members",
            id="administrator-with-groups",
        ),
        pytest.param("member", "Group is not active", id="member-with-an-inactive-group"),
    ],
)
def test_a_profile_refusal_carries_the_409_text_the_people_panel_shows(
    role: str, message: str
) -> None:
    # The requested group is not among the active groups.
    db, admin = _actor_session()
    payload = InvitationCreate(
        email="person@example.com", username="person", role=role, group_ids=[uuid7()]
    )

    with pytest.raises(ProfileValidationError) as error:
        user_service.invite_user(db, payload, actor_id=admin.id, client=_provider([]))

    assert str(error.value) == message
    assert _added(db, User) == []


@pytest.mark.parametrize(
    ("other_administrators", "reserved"),
    [
        pytest.param(0, True, id="first-administrator-is-reserved"),
        pytest.param(1, False, id="second-administrator-is-refused"),
    ],
)
def test_bootstrap_reserves_an_administrator_only_when_none_exists(
    monkeypatch: pytest.MonkeyPatch, other_administrators: int, reserved: bool
) -> None:
    db, provider, _outcomes = _initial_invitation(monkeypatch)
    # The email-or-username lookup, then the count of other administrators.
    db.scalar.side_effect = [None, other_administrators]
    payload = InvitationCreate(email="person@example.com", username="person", role="admin")

    if reserved:
        user_service.invite_user(db, payload, bootstrap=True, client=provider)
    else:
        with pytest.raises(InvitationError):
            user_service.invite_user(db, payload, bootstrap=True, client=provider)

    assert len(_added(db, User)) == int(reserved)


@pytest.mark.parametrize(
    ("stored", "days"),
    [
        pytest.param(1, 1, id="shortest"),
        pytest.param(365, 365, id="longest"),
        pytest.param(0, None, id="below-the-range"),
        pytest.param(366, None, id="above-the-range"),
        pytest.param(None, None, id="missing"),
        pytest.param("30", None, id="text"),
        pytest.param(True, None, id="boolean"),
    ],
)
def test_the_guest_duration_must_be_a_whole_number_of_days_from_1_to_365(
    stored: object, days: int | None
) -> None:
    db = Mock(spec=Session)
    db.scalar.return_value = stored

    if days is None:
        with pytest.raises(InvitationError, match="^Invitation settings are unavailable$"):
            user_service._guest_duration_days(db, uuid7())
    else:
        assert user_service._guest_duration_days(db, uuid7()) == days
