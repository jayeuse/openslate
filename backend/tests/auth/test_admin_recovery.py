"""Elevated administrator recovery sends provider email without a local secret."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.identity.admin_recovery as recovery
from app.core.integrations.supabase_auth import ProviderUser
from app.systems.access.identity.admin_recovery import LocalRecoveryError, recover_local_admin
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User, UserRole, UserStatus
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
        mfa_policy="everyone",
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
        user if query.column_descriptions[0]["entity"] is User else profile
    )
    db.scalars.side_effect = lambda _query: sessions
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
    assert profile.mfa_policy == "everyone"
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
    assert profile.mfa_policy == "optional"
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
    assert profile.mfa_policy == "optional" and profile.ip_allow_list == []
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
    client.admin_delete_factor.side_effect = lambda *_args: setattr(profile, "mfa_policy", "admins")
    with pytest.raises(security.LocalSecurityRecoveryError) as caught:
        security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    assert profile.mfa_policy == "admins"
    assert caught.value.local_reset_committed is True
    assert caught.value.provider_factors_cleared is True
    assert events[-1].outcome == SecurityEventOutcome.PARTIAL


def test_security_recovery_final_commit_failure_reports_completed_provider_effect(
    security_recovery,
) -> None:
    security, db, user, _, _, _, events = security_recovery
    db.commit.side_effect = [None, SQLAlchemyError("private diagnostic")]
    with pytest.raises(security.LocalSecurityRecoveryError) as caught:
        security.recover_workspace_security(db, user.id, local_invocation=True, elevated=True)
    assert caught.value.local_reset_committed is True
    assert caught.value.provider_factors_cleared is True
    assert "private" not in str(caught.value)
    assert events[-1].outcome == SecurityEventOutcome.PARTIAL


@pytest.mark.integration
def test_security_recovery_persists_audited_reset_without_provider_io_in_transaction(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.systems.access.identity.security_recovery as security

    db = integration_owner_db
    user = _admin()
    user_id, provider_id, email = user.id, user.supabase_user_id, user.email
    profile = db.scalar(select(WorkspaceProfile))
    assert profile is not None
    profile_id, revision = profile.id, profile.revision
    profile.mfa_policy = "everyone"
    profile.ip_allow_list = ["10.0.0.0/8"]
    session = IdentitySession(
        id=uuid7(),
        user_id=user_id,
        refresh_token_digest="security-recovery-session",
        csrf_token_digest="security-recovery-csrf",
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    session_id = session.id
    db.add(user)
    db.flush()
    db.add(session)
    db.commit()
    factor_ids = [uuid7()]

    def get_user(_user_id):
        assert not db.in_transaction(), "Provider I/O must release SQL transactions"
        assert _user_id == provider_id
        return ProviderUser(provider_id, None, email)

    def list_factors(_user_id):
        assert not db.in_transaction(), "Provider I/O must release SQL transactions"
        return list(factor_ids)

    def delete_factor(_user_id, factor_id):
        assert not db.in_transaction(), "Provider I/O must release SQL transactions"
        factor_ids.remove(factor_id)

    client = Mock(
        get_admin_user=Mock(side_effect=get_user),
        admin_list_factors=Mock(side_effect=list_factors),
        admin_delete_factor=Mock(side_effect=delete_factor),
    )
    monkeypatch.setattr(security, "get_supabase_auth_client", lambda: client)

    result = security.recover_workspace_security(db, user_id, local_invocation=True, elevated=True)
    db.expire_all()
    profile = db.get(WorkspaceProfile, profile_id)
    session = db.get(IdentitySession, session_id)
    assert profile is not None and session is not None
    assert result.user_id == user_id
    assert profile.mfa_policy == "optional" and profile.ip_allow_list == []
    assert profile.revision == revision + 1
    assert session.revoked_at is not None and factor_ids == []
    events = list(db.scalars(select(SecurityEvent).where(SecurityEvent.subject_id == user_id)))
    assert {event.outcome for event in events} == {"attempt", "success"}
    assert len({event.operation_id for event in events}) == 1
    audit = db.scalar(
        select(AuditLog)
        .where(AuditLog.entity_id == profile_id)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    )
    assert audit is not None and audit.performed_by is None
    assert audit.after is not None and audit.after["ip_allow_list"] == REDACTED
    assert "10.0.0.0" not in str(audit.before) + str(audit.after)
