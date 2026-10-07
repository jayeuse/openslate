"""Elevated administrator recovery sends provider email without a local secret."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from sqlalchemy import select
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
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY
from app.systems.manage.audit.models import AuditLog, SecurityEvent, SecurityEventOutcome
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.manage.workspace.models import WorkspaceProfile


def _admin() -> User:
    role = UserRole.ADMIN
    return User(
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
    user = _admin()
    user.supabase_user_id = None
    db = Mock(spec=Session)
    db.scalar.return_value = user
    with pytest.raises(LocalRecoveryError):
        recover_local_admin(db, user.id, local_invocation=True, elevated=True)
    db.commit.assert_not_called()


def test_recovery_revokes_sessions_then_sends_provider_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = _admin()
    session = IdentitySession(
        id=uuid7(),
        user_id=user.id,
        refresh_token_digest="digest",
        csrf_token_digest="csrf",
        expires_at=datetime.now(UTC) + timedelta(days=7),
    )
    db = Mock(spec=Session)
    db.scalar.return_value = user
    db.scalars.return_value = [session]
    events: list[str] = []
    db.commit.side_effect = lambda: events.append("commit")
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(user.supabase_user_id, None, user.email)
    client.request_recovery.side_effect = lambda _email: events.append("mail")
    monkeypatch.setattr(recovery, "get_supabase_auth_client", lambda: client, raising=False)
    monkeypatch.setattr(recovery, "append_security_event", lambda *_a: None)
    monkeypatch.setattr(
        recovery, "append_committed_security_event", lambda *_a: None, raising=False
    )

    result = recover_local_admin(db, user.id, local_invocation=True, elevated=True)

    assert result.user_id == user.id
    assert not hasattr(result, "temporary_password")
    assert session.revoked_at is not None
    assert events == ["commit", "mail"]
    client.request_recovery.assert_called_once_with(user.email)


def test_recovery_commit_failure_does_not_send_mail(monkeypatch: pytest.MonkeyPatch) -> None:
    user = _admin()
    db = Mock(spec=Session)
    db.scalar.return_value = user
    db.scalars.return_value = []
    db.commit.side_effect = SQLAlchemyError("offline")
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(user.supabase_user_id, None, user.email)
    monkeypatch.setattr(recovery, "get_supabase_auth_client", lambda: client, raising=False)
    monkeypatch.setattr(recovery, "append_security_event", lambda *_a: None)

    with pytest.raises(LocalRecoveryError):
        recover_local_admin(db, user.id, local_invocation=True, elevated=True)
    client.request_recovery.assert_not_called()


@pytest.fixture
def security_recovery(monkeypatch: pytest.MonkeyPatch):
    import app.systems.access.identity.security_recovery as security

    user = _admin()
    profile = WorkspaceProfile(
        id=uuid7(),
        mfa_require_admin=True,
        mfa_require_member=True,
        mfa_require_guest=True,
        mfa_grace_days=3,
        session_absolute_lifetime_minutes=240,
        session_concurrent_limit=2,
        login_failed_attempt_threshold=4,
        ip_allow_list=["10.0.0.0/8"],
        revision=7,
    )
    sessions = [
        IdentitySession(
            id=uuid7(), user_id=user.id, refresh_token_digest="digest", csrf_token_digest="csrf"
        )
    ]
    db = Mock(spec=Session)
    db.scalar.side_effect = lambda query: (
        None
        if query.column_descriptions[0]["entity"] is IdentityMfaObservation
        else user
        if query.column_descriptions[0]["entity"] is User
        else profile
    )
    db.scalars.side_effect = lambda query: (
        [user] if query.column_descriptions[0]["entity"] is User else sessions
    )
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(user.supabase_user_id, None, user.email)
    client.admin_list_factors.side_effect = [[uuid7()], []]
    events = []
    monkeypatch.setattr(security, "get_supabase_auth_client", lambda: client)
    monkeypatch.setattr(security, "append_security_event", lambda _db, event: events.append(event))
    monkeypatch.setattr(security, "append_committed_security_event", events.append)
    return security, db, user, profile, sessions, client, events


@pytest.mark.parametrize("local,elevated", [(False, True), (True, False)])
def test_security_recovery_requires_elevated_local_console(
    security_recovery, local: bool, elevated: bool
) -> None:
    security, db, user, _, _, client, _ = security_recovery
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
    security, db, user, _, _, client, _ = security_recovery
    setattr(user, field, value)
    with pytest.raises(security.LocalSecurityRecoveryError):
        security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    db.commit.assert_not_called()
    client.get_admin_user.assert_not_called()


@pytest.mark.parametrize("mismatch", ["id", "email", "ban"])
def test_security_recovery_validates_bound_provider(security_recovery, mismatch) -> None:
    security, db, user, profile, _, client, _ = security_recovery
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
    security, db, user, profile, sessions, client, events = security_recovery
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
    security, db, user, _, _, client, _ = security_recovery
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

    security, db, user, profile, sessions, client, events = security_recovery
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
    security, db, user, _, _, client, _ = security_recovery
    client.admin_list_factors.side_effect = [[uuid7()], [uuid7()]]
    with pytest.raises(security.LocalSecurityRecoveryError) as caught:
        security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    assert caught.value.local_reset_committed is True
    assert caught.value.provider_factors_cleared is False


def test_security_recovery_does_not_overwrite_concurrently_changed_policy(
    security_recovery,
) -> None:
    security, db, user, profile, _, client, events = security_recovery
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
    security, db, user, _, _, _, events = security_recovery
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
    user = _admin()
    user_id, provider_id, email = user.id, user.supabase_user_id, user.email
    profile = db.scalar(select(WorkspaceProfile))
    assert profile is not None
    profile_id, revision = profile.id, profile.revision
    fields = (
        "mfa_require_admin",
        "mfa_require_member",
        "mfa_require_guest",
        "mfa_grace_days",
        "session_absolute_lifetime_minutes",
        "session_concurrent_limit",
        "login_failed_attempt_threshold",
        "ip_allow_list",
        "revision",
        "updated_at",
        "performed_by",
    )
    saved = {field: getattr(profile, field) for field in fields}
    episodes = {
        row.id: (row.mfa_required_since, row.updated_at, row.performed_by)
        for row in db.scalars(select(User))
    }
    request_id = db.info[AUDIT_CONTEXT_KEY].request_id

    def cleanup():
        db.rollback()
        db.close()
        with Session(engine) as restore:
            for row in restore.scalars(
                select(SecurityEvent).where(SecurityEvent.subject_id == user_id)
            ):
                restore.delete(row)
            owned = restore.get(User, user_id)
            if owned is not None:
                restore.delete(owned)
            current = restore.get(WorkspaceProfile, profile_id)
            for field, value in saved.items():
                setattr(current, field, value)
            for row in restore.scalars(select(User).where(User.id.in_(episodes))):
                row.mfa_required_since, row.updated_at, row.performed_by = episodes[row.id]
            for row in restore.scalars(select(AuditLog).where(AuditLog.request_id == request_id)):
                restore.delete(row)
            restore.commit()

    request.addfinalizer(cleanup)
    profile.mfa_require_admin = profile.mfa_require_member = profile.mfa_require_guest = True
    user.mfa_required_since = datetime.now(UTC) - timedelta(days=1)
    profile.session_absolute_lifetime_minutes = 240
    profile.session_concurrent_limit = 2
    profile.mfa_grace_days = 3
    profile.login_failed_attempt_threshold = 4
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
    assert db.get(User, user_id).mfa_required_since is None
    assert (profile.session_absolute_lifetime_minutes, profile.session_concurrent_limit) == (240, 2)
    assert profile.mfa_grace_days == 3 and profile.login_failed_attempt_threshold == 4
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
