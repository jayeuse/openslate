"""Elevated administrator recovery sends provider email without a local secret."""

from contextlib import suppress
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, Mock

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.identity.admin_recovery as recovery
import app.systems.access.identity.mfa_observations as observations
from app.core.database.session import AuditSession
from app.core.integrations.supabase_auth import (
    ProviderFactor,
    ProviderUser,
    SupabaseAuthUnavailable,
)
from app.systems.access.identity.admin_recovery import LocalRecoveryError, recover_local_admin
from app.systems.access.identity.models import IdentityMfaObservation, IdentitySession
from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY
from app.systems.manage.audit.models import AuditLog, SecurityEvent, SecurityEventOutcome
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.manage.workspace.models import PlatformSettings, WorkspaceProfile
from tests.conftest import create_member, create_organization


def _admin() -> tuple[User, Membership]:
    role = UserRole.ADMIN
    return create_member(None, WorkspaceProfile(id=uuid7()),
        id=uuid7(),
        email="admin@example.com",
        username="admin",
        supabase_user_id=uuid7(),
        status=UserStatus.ACTIVE.value,
        role=role,
    )


@pytest.mark.parametrize("local,elevated", [(False, True), (True, False)])
def test_recovery_refuses_nonlocal_or_non_elevated(local: bool, elevated: bool) -> None:
    with pytest.raises(LocalRecoveryError):
        recover_local_admin(Mock(spec=Session), uuid7(), local_invocation=local, elevated=elevated)


def test_recovery_refuses_unbound_or_ineligible_administrator() -> None:
    user, membership = _admin()
    user.supabase_user_id = None
    db = Mock(spec=Session)
    db.dirty = set()
    db.scalars.return_value.all.return_value = [membership]
    db.scalar.return_value = user
    with pytest.raises(LocalRecoveryError):
        recover_local_admin(db, user.id, local_invocation=True, elevated=True)
    db.commit.assert_not_called()


def test_recovery_revokes_sessions_then_sends_provider_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user, membership = _admin()
    session = IdentitySession(
        id=uuid7(),
        user_id=user.id,
        refresh_token_digest="digest",
        csrf_token_digest="csrf",
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    db = Mock(spec=Session)
    db.dirty = set()
    db.scalar.return_value = user
    db.scalars.side_effect = lambda query: (
        Mock(all=lambda: [membership])
        if query.column_descriptions[0]["entity"] is Membership else [session]
    )
    events: list[str] = []
    db.commit.side_effect = lambda: events.append("commit")
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(user.supabase_user_id, None, user.email)
    client.request_recovery.side_effect = lambda _email: events.append("mail")
    event_organizations: list[object] = []
    monkeypatch.setattr(recovery, "get_supabase_auth_client", lambda: client, raising=False)
    monkeypatch.setattr(
        recovery,
        "append_security_event",
        lambda _db, _event, *, org_id: event_organizations.append(org_id),
    )
    monkeypatch.setattr(
        recovery,
        "append_committed_security_event",
        lambda _event, *, org_id: event_organizations.append(org_id),
    )

    result = recover_local_admin(db, user.id, local_invocation=True, elevated=True)

    assert result.user_id == user.id
    assert not hasattr(result, "temporary_password")
    assert session.revoked_at is not None
    assert events == ["commit", "mail"]
    client.request_recovery.assert_called_once_with(user.email)
    # Both events belong to the organization whose administrator was recovered.
    assert event_organizations == [membership.org_id, membership.org_id]


def test_recovery_commit_failure_does_not_send_mail(monkeypatch: pytest.MonkeyPatch) -> None:
    user, membership = _admin()
    db = Mock(spec=Session)
    db.dirty = set()
    db.scalar.return_value = user
    db.scalars.side_effect = lambda query: (
        Mock(all=lambda: [membership])
        if query.column_descriptions[0]["entity"] is Membership else []
    )
    db.commit.side_effect = SQLAlchemyError("offline")
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(user.supabase_user_id, None, user.email)
    monkeypatch.setattr(recovery, "get_supabase_auth_client", lambda: client, raising=False)
    monkeypatch.setattr(recovery, "append_security_event", lambda *_a, **_k: None)

    with pytest.raises(LocalRecoveryError):
        recover_local_admin(db, user.id, local_invocation=True, elevated=True)
    client.request_recovery.assert_not_called()


def test_recovery_needs_a_named_organization_before_any_provider_effect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user, membership = _admin()
    _second_user, other = _admin()
    db = Mock(spec=Session)
    db.dirty = set()
    db.scalar.return_value = user
    db.scalars.side_effect = lambda query: (
        Mock(all=lambda: [membership, other])
        if query.column_descriptions[0]["entity"] is Membership
        else Mock(all=lambda: ["first-organization", "second-organization"])
    )
    client = Mock()
    monkeypatch.setattr(recovery, "get_supabase_auth_client", lambda: client, raising=False)

    with pytest.raises(recovery.OrganizationChoiceRequired) as caught:
        recover_local_admin(db, user.id, local_invocation=True, elevated=True)
    assert caught.value.slugs == ("first-organization", "second-organization")
    db.rollback.assert_called_once()
    db.commit.assert_not_called()
    client.get_admin_user.assert_not_called()
    client.request_recovery.assert_not_called()


# (memberships: organization label -> role, the --organization value, expected result)
RECOVERY_ORGANIZATION_CASES = {
    "only-administered-organization": ({"a": "admin", "b": "member"}, None, "a"),
    "several-without-the-flag": ({"a": "admin", "b": "admin"}, None, "choice"),
    "several-named-by-slug": ({"a": "admin", "b": "admin"}, "b-slug", "b"),
    "several-named-by-id": ({"a": "admin", "b": "admin"}, "b-id", "b"),
    "named-where-only-a-member": ({"a": "admin", "b": "member"}, "b-slug", None),
    "named-without-a-membership": ({"a": "admin"}, "b-slug", None),
    "member-of-the-only-organization": ({"a": "member"}, None, None),
}


@pytest.mark.integration
@pytest.mark.parametrize(
    ("roles", "named", "expected"),
    RECOVERY_ORGANIZATION_CASES.values(),
    ids=RECOVERY_ORGANIZATION_CASES.keys(),
)
def test_recovery_acts_only_in_one_organization_the_person_administers(
    integration_owner_db: Session, roles, named, expected
) -> None:
    db = integration_owner_db
    suffix = uuid7().hex
    organizations = {
        label: create_organization(db, slug=f"recovery-{label}-{suffix}") for label in "ab"
    }
    person = None
    for label, role in roles.items():
        person, _ = create_member(db, organizations[label], role, user=person)
    assert person is not None
    organization = (
        None
        if named is None
        else organizations[named[0]].slug
        if named.endswith("slug")
        else str(organizations[named[0]].id)
    )

    if expected == "choice":
        with pytest.raises(recovery.OrganizationChoiceRequired) as caught:
            recovery.administered_membership(db, person.id, organization)
        assert caught.value.slugs == (f"recovery-a-{suffix}", f"recovery-b-{suffix}")
        return
    membership = recovery.administered_membership(db, person.id, organization)
    if expected is None:
        assert membership is None
    else:
        assert membership is not None
        assert (membership.org_id, membership.role) == (organizations[expected].id, "admin")


@pytest.fixture
def security_recovery(monkeypatch: pytest.MonkeyPatch):
    import app.systems.access.identity.security_recovery as security

    user, membership = _admin()
    profile = WorkspaceProfile(
        id=membership.org_id,
        mfa_require_admin=True,
        mfa_require_member=True,
        mfa_require_guest=True,
        mfa_grace_days=3,
        ip_allow_list=["10.0.0.0/8"],
        revision=7,
    )
    sessions = [
        IdentitySession(
            id=uuid7(), user_id=user.id, refresh_token_digest="digest", csrf_token_digest="csrf"
        )
    ]
    db = Mock(spec=Session)
    db.dirty = set()
    db.scalar.side_effect = lambda query: (
        None
        if query.column_descriptions[0]["entity"] is IdentityMfaObservation
        else user
        if query.column_descriptions[0]["entity"] is User
        else profile
    )
    db.scalars.side_effect = lambda query: (
        MagicMock(all=lambda: [membership], __iter__=lambda _self: iter([membership]))
        if query.column_descriptions[0]["entity"] is Membership else sessions
    )
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(user.supabase_user_id, None, user.email)
    client.admin_list_factors.side_effect = [[uuid7()], []]
    events = []

    def record(event, *, org_id):
        # Every recovery event belongs to the organization whose policy is reset.
        assert org_id == membership.org_id
        events.append(event)

    monkeypatch.setattr(security, "get_supabase_auth_client", lambda: client)
    monkeypatch.setattr(
        security,
        "append_security_event",
        lambda _db, event, *, org_id: record(event, org_id=org_id),
    )
    monkeypatch.setattr(security, "append_committed_security_event", record)
    return security, db, user, profile, sessions, client, events, membership


@pytest.mark.parametrize("local,elevated", [(False, True), (True, False)])
def test_security_recovery_requires_elevated_local_console(
    security_recovery, local: bool, elevated: bool
) -> None:
    security, db, user, _, _, client, _, _membership = security_recovery
    with pytest.raises(security.LocalSecurityRecoveryError):
        security.recover_workspace_security(db, user.id, local_invocation=local, elevated=elevated)
    db.scalar.assert_not_called()
    db.commit.assert_not_called()
    client.get_admin_user.assert_not_called()


@pytest.mark.parametrize(
    "field,value",
    [
        ("supabase_user_id", None),
        ("status", "invited"),
        ("role", "member"),
        ("is_deleted", True),
        ("expires_at", datetime.now(UTC) - timedelta(days=1)),
    ],
)
def test_security_recovery_refuses_ineligible_admin(security_recovery, field, value) -> None:
    security, db, user, _, _, client, _, membership = security_recovery
    setattr(membership if field in {"role", "expires_at"} else user, field, value)
    with pytest.raises(security.LocalSecurityRecoveryError):
        security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    db.commit.assert_not_called()
    client.get_admin_user.assert_not_called()


@pytest.mark.parametrize("mismatch", ["id", "email", "ban"])
def test_security_recovery_validates_bound_provider(security_recovery, mismatch) -> None:
    security, db, user, profile, _, client, _, _membership = security_recovery
    client.get_admin_user.return_value = ProviderUser(
        uuid7() if mismatch == "id" else user.supabase_user_id,
        datetime.now(UTC) + timedelta(days=1) if mismatch == "ban" else None,
        "another@example.com" if mismatch == "email" else user.email,
    )
    with pytest.raises(security.LocalSecurityRecoveryError):
        security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    assert profile.mfa_require_admin and profile.mfa_require_member and profile.mfa_require_guest
    db.commit.assert_not_called()
    client.admin_list_factors.assert_not_called()


def test_security_recovery_clears_policy_factors_and_newly_admitted_sessions(
    security_recovery,
) -> None:
    security, db, user, profile, sessions, client, events, _membership = security_recovery
    late_session = IdentitySession(
        id=uuid7(), user_id=user.id, refresh_token_digest="late", csrf_token_digest="late"
    )
    client.admin_delete_factor.side_effect = lambda *_args: sessions.append(late_session)

    result = security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)

    assert result.user_id == user.id
    assert not any(
        (profile.mfa_require_admin, profile.mfa_require_member, profile.mfa_require_guest)
    )
    assert profile.ip_allow_list == []
    assert profile.revision == 8
    assert all(session.revoked_at is not None for session in sessions)
    client.admin_delete_factor.assert_called_once()
    assert [event.outcome for event in events] == [
        SecurityEventOutcome.ATTEMPT,
        SecurityEventOutcome.SUCCESS,
    ]
    assert events[0].operation_id == events[1].operation_id
    assert all(event.actor_id is None and event.subject_id == user.id for event in events)
    assert "10.0.0.0" not in str(events)


def test_security_recovery_local_commit_failure_prevents_factor_deletion(
    security_recovery,
) -> None:
    security, db, user, _, _, client, _, _membership = security_recovery
    db.commit.side_effect = SQLAlchemyError("private database diagnostic")
    with pytest.raises(security.LocalSecurityRecoveryError) as caught:
        security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    assert caught.value.local_reset_committed is None
    assert caught.value.provider_factors_cleared is False
    assert "private" not in str(caught.value)
    client.admin_list_factors.assert_not_called()
    client.admin_delete_factor.assert_not_called()


def test_security_recovery_partial_factor_failure_is_truthful_and_rerunnable(
    security_recovery,
) -> None:
    from app.core.integrations.supabase_auth import SupabaseAuthUnavailable

    security, db, user, profile, sessions, client, events, _membership = security_recovery
    factor_id = uuid7()
    client.admin_list_factors.side_effect = [[factor_id], [factor_id], []]
    client.admin_delete_factor.side_effect = [SupabaseAuthUnavailable("private provider"), None]
    with pytest.raises(security.LocalSecurityRecoveryError) as caught:
        security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    assert caught.value.local_reset_committed is True
    assert caught.value.provider_factors_cleared is None
    assert "private" not in str(caught.value)
    assert (
        not any((profile.mfa_require_admin, profile.mfa_require_member, profile.mfa_require_guest))
        and profile.ip_allow_list == []
    )
    assert sessions[0].revoked_at is not None
    assert events[-1].outcome == SecurityEventOutcome.PARTIAL

    result = security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    assert result.user_id == user.id
    assert profile.revision == 8
    assert events[-1].outcome == SecurityEventOutcome.SUCCESS


def test_security_recovery_refuses_factors_remaining_after_cleanup(security_recovery) -> None:
    security, db, user, _, _, client, _, _membership = security_recovery
    client.admin_list_factors.side_effect = [[uuid7()], [uuid7()]]
    with pytest.raises(security.LocalSecurityRecoveryError) as caught:
        security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    assert caught.value.local_reset_committed is True
    assert caught.value.provider_factors_cleared is False


def test_security_recovery_does_not_overwrite_concurrently_changed_policy(
    security_recovery,
) -> None:
    security, db, user, profile, _, client, events, _membership = security_recovery
    client.admin_delete_factor.side_effect = lambda *_args: setattr(
        profile, "mfa_require_admin", True
    )
    with pytest.raises(security.LocalSecurityRecoveryError) as caught:
        security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    assert profile.mfa_require_admin
    assert caught.value.local_reset_committed is True
    assert caught.value.provider_factors_cleared is True
    assert events[-1].outcome == SecurityEventOutcome.PARTIAL


@pytest.mark.parametrize("failure_commit", [2, 3])
def test_security_recovery_final_commit_failure_reports_completed_provider_effect(
    security_recovery,
    failure_commit: int,
) -> None:
    security, db, user, _, _, _, events, _membership = security_recovery
    fault = SQLAlchemyError("private diagnostic")
    db.commit.side_effect = [None] * (failure_commit - 1) + [fault, None]
    with pytest.raises(security.LocalSecurityRecoveryError) as caught:
        security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    assert caught.value.local_reset_committed is True
    assert caught.value.provider_factors_cleared is True
    assert "private" not in str(caught.value)
    assert events[-1].outcome == SecurityEventOutcome.PARTIAL


@pytest.mark.integration
@pytest.mark.parametrize("failure", [False, True, "final_projection"])
def test_security_recovery_persists_audited_reset_without_provider_io_in_transaction(
    integration_owner_db: Session,
    monkeypatch: pytest.MonkeyPatch,
    failure: bool | str,
    request,
) -> None:
    import app.systems.access.identity.security_recovery as security

    engine = integration_owner_db.get_bind().engine
    db = AuditSession(engine)
    db.info.update(integration_owner_db.info)
    profile_id, user_id = uuid7(), uuid7()
    request_id = db.info[AUDIT_CONTEXT_KEY].request_id
    saved: dict[str, object] = {}

    def cleanup():
        # Registered before any row exists, so a failure anywhere in the test (or in this
        # session) cannot leave the organization, account or settings change behind.
        with suppress(Exception):
            db.rollback()
        with suppress(Exception):
            db.close()
        with Session(engine) as restore:
            restore.execute(
                delete(SecurityEvent).where(
                    (SecurityEvent.subject_id == user_id) | (SecurityEvent.org_id == profile_id)
                )
            )
            restore.execute(
                delete(AuditLog).where(
                    (AuditLog.org_id == profile_id) | (AuditLog.request_id == request_id)
                )
            )
            restore.execute(delete(Membership).where(Membership.org_id == profile_id))
            restore.execute(delete(User).where(User.id == user_id))
            restore.execute(delete(WorkspaceProfile).where(WorkspaceProfile.id == profile_id))
            if saved:
                restore.execute(update(PlatformSettings).values(**saved))
            restore.commit()

    request.addfinalizer(cleanup)
    profile = create_organization(db, id=profile_id)
    user, membership = create_member(
        db, profile, role=UserRole.ADMIN, id=user_id, supabase_user_id=uuid7(),
    )
    provider_id, email = user.supabase_user_id, user.email
    membership_id = membership.id
    revision = profile.revision
    platform = db.scalars(select(PlatformSettings)).one()
    saved.update(
        {
            field: getattr(platform, field)
            for field in (
                "session_absolute_lifetime_minutes",
                "session_concurrent_limit",
                "login_failed_attempt_threshold",
                "revision",
                "updated_at",
                "performed_by",
            )
        }
    )
    profile.mfa_require_admin = profile.mfa_require_member = profile.mfa_require_guest = True
    membership.mfa_required_since = datetime.now(UTC) - timedelta(days=1)
    platform.session_absolute_lifetime_minutes = 240
    platform.session_concurrent_limit = 2
    profile.mfa_grace_days = 3
    platform.login_failed_attempt_threshold = 4
    profile.ip_allow_list = ["10.0.0.0/8"]

    def make_session():
        return IdentitySession(
            id=uuid7(),
            user_id=user_id,
            refresh_token_digest=str(uuid7()),
            csrf_token_digest="security-recovery-csrf",
            expires_at=datetime.now(UTC) + timedelta(days=1),
        )

    session, late_session = make_session(), make_session()
    session_id, late_session_id = session.id, late_session.id
    db.add(user)
    db.flush()
    db.add(session)
    db.add(
        IdentityMfaObservation(
            user_id=user_id,
            observed_provider_user_id=provider_id,
            verified_totp=True,
            observed_at=datetime.now(UTC) - timedelta(minutes=1),
        )
    )
    db.commit()
    factor_ids = [uuid7()]

    def get_user(_user_id):
        assert not db.in_transaction(), "Provider I/O must release SQL transactions"
        assert _user_id == provider_id
        return ProviderUser(provider_id, None, email)

    def list_factors(_user_id):
        assert not db.in_transaction(), "Provider I/O must release SQL transactions"
        return list(factor_ids)

    interleaved = []

    def delete_factor(_user_id, factor_id):
        assert not db.in_transaction(), "Provider I/O must release SQL transactions"
        with Session(engine) as readback:
            observation = readback.get(IdentityMfaObservation, user_id)
            assert observation.verified_totp is None
            assert observation.observed_provider_user_id == provider_id
            assert observation.observed_at is not None
            if failure == "final_projection":
                readback.add(late_session)
                readback.commit()
        if failure is True:
            with Session(engine) as observer:
                observations.record_provider_observation(
                    observer,
                    user_id,
                    ProviderUser(
                        provider_id,
                        None,
                        email,
                        factors=(ProviderFactor(factor_id, "totp", "verified"),),
                    ),
                    observations.observation_started_at(),
                )
                observer.commit()
                interleaved.append(observer.get(IdentityMfaObservation, user_id).observed_at)
            raise SupabaseAuthUnavailable("Owned provider removal failure")
        factor_ids.remove(factor_id)

    client = Mock(
        get_admin_user=Mock(side_effect=get_user),
        admin_list_factors=Mock(side_effect=list_factors),
        admin_delete_factor=Mock(side_effect=delete_factor),
    )
    monkeypatch.setattr(security, "get_supabase_auth_client", lambda: client)
    original_record = security.record_observation

    def record_projection(*args):
        if failure == "final_projection" and args[3] is False:
            raise SQLAlchemyError("Owned final observation persistence failure")
        return original_record(*args)

    monkeypatch.setattr(security, "record_observation", record_projection)
    if failure:
        with pytest.raises(security.LocalSecurityRecoveryError) as caught:
            security.recover_workspace_security(db, user_id, local_invocation=True, elevated=True)
        assert caught.value.local_reset_committed is True
        assert caught.value.provider_factors_cleared is (True if isinstance(failure, str) else None)
    else:
        result = security.recover_workspace_security(
            db, user_id, local_invocation=True, elevated=True
        )
        assert result.user_id == user_id
    db.expire_all()
    profile = db.get(WorkspaceProfile, profile_id)
    session = db.get(IdentitySession, session_id)
    assert profile is not None and session is not None
    assert (
        not any((profile.mfa_require_admin, profile.mfa_require_member, profile.mfa_require_guest))
        and profile.ip_allow_list == []
    )
    assert profile.revision == revision + 1
    assert db.get(Membership, membership_id).mfa_required_since is None
    assert (platform.session_absolute_lifetime_minutes, platform.session_concurrent_limit) == (
        240, 2,
    )
    assert profile.mfa_grace_days == 3 and platform.login_failed_attempt_threshold == 4
    assert session.revoked_at is not None
    assert bool(factor_ids) is (failure is True)
    observation = db.get(IdentityMfaObservation, user_id)
    assert observation.verified_totp is (None if failure else False)
    assert observation.observed_at is not None
    if failure is True:
        assert observation.observed_at > interleaved[0]
    assert observation.observed_provider_user_id == provider_id
    events = list(db.scalars(select(SecurityEvent).where(SecurityEvent.subject_id == user_id)))
    assert {event.outcome for event in events} == {
        "attempt",
        "partial" if failure else "success",
    }
    assert len({event.operation_id for event in events}) == 1
    audit = db.scalar(
        select(AuditLog)
        .where(AuditLog.entity_id == profile_id)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    )
    assert audit is not None and audit.performed_by is None
    assert audit.after is not None and audit.after["ip_allow_list"] == REDACTED
    assert "10.0.0.0" not in str(audit.before) + str(audit.after)
    if failure == "final_projection":
        with Session(engine) as readback:
            late = readback.get(IdentitySession, late_session_id)
            assert late is not None and late.revoked_at is not None
