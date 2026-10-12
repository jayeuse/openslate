"""A provider identity may bind only to an explicit pending local invitation."""

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.service as service
from app.core.integrations.supabase_auth import (
    ProviderUser,
    ProviderUserNotFound,
    SupabaseAuthUnavailable,
)
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import User, UserStatus
from app.systems.access.users.schemas import InvitationCreate


@pytest.fixture
def fresh_admin(monkeypatch: pytest.MonkeyPatch) -> None:
    """The actor passes the fresh administrator check, which has its own owner tests.

    The bootstrap test runs without it: bootstrap has no actor and never runs the check.
    """

    monkeypatch.setattr(service, "require_fresh_exact_admin", lambda *_args: None)


def _pending_profile(local_id: UUID, operation_id: UUID, **values: Any) -> User:
    """A pending invitation profile; ``Mock(spec=Session).scalar`` returns it as the lock read."""

    return User(
        **{
            "id": local_id,
            "email": "person@example.test",
            "status": UserStatus.PENDING.value,
            "is_deleted": False,
            "provider_invitation_operation_id": operation_id,
            "invitation_sent_at": None,
            **values,
        }
    )


@pytest.mark.usefixtures("fresh_admin")
def test_reconciliation_requires_exact_provider_admin_marker() -> None:
    db = Mock(spec=Session)
    actor_id, local_id, operation_id, provider_id = uuid7(), uuid7(), uuid7(), uuid7()
    profile = _pending_profile(local_id, operation_id, supabase_user_id=None)
    client = Mock()
    client.find_invitation_user.return_value = ProviderUser(
        provider_id, None, "person@example.test", {"openslate_user_id": "wrong"}
    )
    db.scalar.return_value = profile

    with pytest.raises(InvitationError):
        service.reconcile_invitation(db, local_id, actor_id=actor_id, client=client)

    assert profile.supabase_user_id is None
    db.commit.assert_not_called()


@pytest.mark.usefixtures("fresh_admin")
def test_reconciliation_binds_only_owned_provider_user() -> None:
    db = Mock(spec=Session)
    actor_id, local_id, operation_id, provider_id = uuid7(), uuid7(), uuid7(), uuid7()
    profile = _pending_profile(local_id, operation_id, supabase_user_id=None)
    client = Mock()
    marker = {
        "openslate_user_id": str(local_id),
        "openslate_invitation_operation_id": str(operation_id),
    }
    client.find_invitation_user.return_value = ProviderUser(
        provider_id, None, "person@example.test", marker
    )
    client.admin_send_invitation.return_value = ProviderUser(provider_id, None)
    db.scalar.return_value = profile

    result = service.reconcile_invitation(db, local_id, actor_id=actor_id, client=client)

    assert result is profile
    assert profile.supabase_user_id == provider_id
    assert profile.invitation_sent_at is not None
    db.commit.assert_called_once()


@pytest.mark.usefixtures("fresh_admin")
def test_invitation_persists_pending_profile_before_provider_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    actor_id, operation_id, provider_id = uuid7(), uuid7(), uuid7()
    payload = InvitationCreate(email="person@example.test", username="person")
    events: list[str] = []
    db.scalar.return_value = None
    db.commit.side_effect = lambda: events.append("commit")

    def assign_user_id() -> None:
        for call in db.add.call_args_list:
            if isinstance(call.args[0], User):
                call.args[0].id = uuid7()
                db.scalar.return_value = call.args[0]

    db.flush.side_effect = assign_user_id
    monkeypatch.setattr(service, "validate_identity_profile", lambda *_args, **_kw: None)
    monkeypatch.setattr(service, "append_security_event", lambda *_args: None)
    monkeypatch.setattr(service, "_record_invitation_failure", lambda *_args: None)
    monkeypatch.setattr(service, "uuid7", lambda: operation_id)

    client = Mock()

    def create(email: str, local_id: object, marker: object) -> ProviderUser:
        events.append("create")
        assert events[0] == "commit"
        assert marker == operation_id
        return ProviderUser(
            provider_id,
            None,
            email,
            {
                "openslate_user_id": str(local_id),
                "openslate_invitation_operation_id": str(marker),
            },
        )

    def send(email: str) -> ProviderUser:
        events.append("send")
        return ProviderUser(provider_id, None, email)

    client.admin_create_invitation_user.side_effect = create
    client.admin_send_invitation.side_effect = send
    user = service.invite_user(db, payload, actor_id=actor_id, client=client)

    assert events == ["commit", "create", "send", "commit"]
    assert user.supabase_user_id == provider_id
    assert user.invitation_sent_at is not None


@pytest.mark.usefixtures("fresh_admin")
def test_resend_rechecks_bound_provider_identity_before_mail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    actor_id, local_id, operation_id, provider_id = uuid7(), uuid7(), uuid7(), uuid7()
    profile = _pending_profile(local_id, operation_id, supabase_user_id=provider_id)
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(
        provider_id, None, profile.email, {"openslate_user_id": "wrong"}
    )
    monkeypatch.setattr(service, "_security_event", lambda **_kw: None)
    monkeypatch.setattr(service, "_record_invitation_failure", lambda *_args, **_kw: None)
    db.scalar.return_value = profile

    with pytest.raises(InvitationError):
        service.resend_invitation(db, local_id, actor_id=actor_id, client=client)

    client.admin_send_invitation.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.usefixtures("fresh_admin")
def test_resend_rejects_admin_response_with_a_different_bound_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    actor_id, local_id, operation_id, bound_id, other_id = (
        uuid7(),
        uuid7(),
        uuid7(),
        uuid7(),
        uuid7(),
    )
    profile = _pending_profile(local_id, operation_id, supabase_user_id=bound_id)
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(
        other_id,
        None,
        profile.email,
        {
            "openslate_user_id": str(local_id),
            "openslate_invitation_operation_id": str(operation_id),
        },
    )
    monkeypatch.setattr(service, "_security_event", lambda **_kw: None)
    monkeypatch.setattr(service, "_record_invitation_failure", lambda *_args, **_kw: None)
    db.scalar.return_value = profile

    with pytest.raises(InvitationError):
        service.resend_invitation(db, local_id, actor_id=actor_id, client=client)

    assert profile.supabase_user_id == bound_id
    client.admin_send_invitation.assert_not_called()
    client.admin_delete_user.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.usefixtures("fresh_admin")
def test_reconcile_creates_missing_provider_user_from_committed_pending_marker() -> None:
    db = Mock(spec=Session)
    actor_id, local_id, operation_id, provider_id = uuid7(), uuid7(), uuid7(), uuid7()
    profile = _pending_profile(local_id, operation_id, supabase_user_id=None)
    marker = {
        "openslate_user_id": str(local_id),
        "openslate_invitation_operation_id": str(operation_id),
    }
    client = Mock()
    client.find_invitation_user.return_value = None
    client.admin_create_invitation_user.return_value = ProviderUser(
        provider_id, None, profile.email, marker
    )
    client.admin_send_invitation.return_value = ProviderUser(provider_id, None)
    db.scalar.return_value = profile

    result = service.reconcile_invitation(db, local_id, actor_id=actor_id, client=client)

    assert result.supabase_user_id == provider_id
    assert result.invitation_sent_at is not None
    client.admin_create_invitation_user.assert_called_once_with(
        profile.email, local_id, operation_id
    )


def test_bootstrap_reconcile_rejects_nonsole_pending_admin() -> None:
    db = Mock(spec=Session)
    local_id, operation_id = uuid7(), uuid7()
    profile = _pending_profile(
        local_id, operation_id, email="admin@example.test", supabase_user_id=None, role="admin"
    )
    client = Mock()
    # The first scalar locks the profile; the second counts the other administrators.
    db.scalar.side_effect = [profile, 1]

    with pytest.raises(InvitationError):
        service.reconcile_invitation(db, local_id, actor_id=None, bootstrap=True, client=client)

    client.find_invitation_user.assert_not_called()


@pytest.mark.usefixtures("fresh_admin")
def test_resend_replaces_owned_confirmed_identity_after_revoked_link(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    actor_id, local_id, operation_id, old_id, new_id = (uuid7(), uuid7(), uuid7(), uuid7(), uuid7())
    profile = _pending_profile(local_id, operation_id, supabase_user_id=old_id)
    marker = {
        "openslate_user_id": str(local_id),
        "openslate_invitation_operation_id": str(operation_id),
    }
    confirmed = SimpleNamespace(
        id=old_id,
        email=profile.email,
        app_metadata=marker,
        email_confirmed_at=datetime.now(UTC),
    )
    replacement = ProviderUser(new_id, None, profile.email, marker)
    client = Mock()
    client.get_admin_user.return_value = confirmed
    client.find_invitation_user.return_value = None
    client.admin_create_invitation_user.return_value = replacement
    client.admin_send_invitation.return_value = ProviderUser(new_id, None)
    monkeypatch.setattr(service, "_security_event", lambda **_kw: None)
    monkeypatch.setattr(service, "append_security_event", lambda *_args: None)
    db.scalar.return_value = profile

    result = service.resend_invitation(db, local_id, actor_id=actor_id, client=client)

    assert result.supabase_user_id == new_id
    assert result.invitation_sent_at is not None
    client.admin_delete_user.assert_called_once_with(old_id)
    client.admin_create_invitation_user.assert_called_once_with(
        profile.email, local_id, operation_id
    )
    db.commit.assert_called_once()


@pytest.mark.usefixtures("fresh_admin")
def test_reconcile_resumes_replacement_after_old_identity_was_deleted() -> None:
    db = Mock(spec=Session)
    actor_id, local_id, operation_id, old_id, replacement_id = (
        uuid7(),
        uuid7(),
        uuid7(),
        uuid7(),
        uuid7(),
    )
    profile = _pending_profile(local_id, operation_id, supabase_user_id=old_id)
    marker = {
        "openslate_user_id": str(local_id),
        "openslate_invitation_operation_id": str(operation_id),
    }
    client = Mock()
    client.get_admin_user.side_effect = ProviderUserNotFound()
    client.find_invitation_user.return_value = ProviderUser(
        replacement_id, None, profile.email, marker
    )
    client.admin_send_invitation.return_value = ProviderUser(replacement_id, None)
    db.scalar.return_value = profile

    result = service.reconcile_invitation(db, local_id, actor_id=actor_id, client=client)

    assert result.supabase_user_id == replacement_id
    assert result.invitation_sent_at is not None
    client.admin_delete_user.assert_not_called()
    client.admin_create_invitation_user.assert_not_called()
    db.commit.assert_called_once()


@pytest.mark.usefixtures("fresh_admin")
def test_resend_preserves_binding_when_provider_lookup_is_not_authoritative(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = Mock(spec=Session)
    actor_id, local_id, operation_id, old_id = uuid7(), uuid7(), uuid7(), uuid7()
    profile = _pending_profile(local_id, operation_id, supabase_user_id=old_id)
    client = Mock()
    client.get_admin_user.side_effect = SupabaseAuthUnavailable("provider denied")
    monkeypatch.setattr(service, "_security_event", lambda **_kw: None)
    monkeypatch.setattr(service, "_record_invitation_failure", lambda *_args, **_kw: None)
    db.scalar.return_value = profile

    with pytest.raises(InvitationError):
        service.resend_invitation(db, local_id, actor_id=actor_id, client=client)

    assert profile.supabase_user_id == old_id
    client.admin_delete_user.assert_not_called()
    client.admin_create_invitation_user.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.usefixtures("fresh_admin")
def test_reconcile_does_not_delete_identity_with_recorded_acceptance() -> None:
    db = Mock(spec=Session)
    actor_id, local_id, operation_id, bound_id = uuid7(), uuid7(), uuid7(), uuid7()
    profile = _pending_profile(
        local_id, operation_id, supabase_user_id=bound_id, invitation_accepted_at=datetime.now(UTC)
    )
    client = Mock()
    client.get_admin_user.return_value = ProviderUser(
        bound_id,
        None,
        profile.email,
        {
            "openslate_user_id": str(local_id),
            "openslate_invitation_operation_id": str(operation_id),
        },
        datetime.now(UTC),
    )
    db.scalar.return_value = profile

    with pytest.raises(InvitationError):
        service.reconcile_invitation(db, local_id, actor_id=actor_id, client=client)

    client.get_admin_user.assert_not_called()
    client.admin_delete_user.assert_not_called()
    db.commit.assert_not_called()


@pytest.mark.usefixtures("fresh_admin")
def test_reconcile_never_rebinds_deleted_old_identity_from_stale_search() -> None:
    db = Mock(spec=Session)
    actor_id, local_id, operation_id, old_id, replacement_id = (
        uuid7(),
        uuid7(),
        uuid7(),
        uuid7(),
        uuid7(),
    )
    profile = _pending_profile(local_id, operation_id, supabase_user_id=old_id)
    marker = {
        "openslate_user_id": str(local_id),
        "openslate_invitation_operation_id": str(operation_id),
    }
    client = Mock()
    client.get_admin_user.side_effect = ProviderUserNotFound()
    client.find_invitation_user.side_effect = [
        ProviderUser(replacement_id, None, profile.email, marker, datetime.now(UTC)),
        ProviderUser(old_id, None, profile.email, marker),
    ]
    db.scalar.return_value = profile

    with pytest.raises(InvitationError):
        service.reconcile_invitation(db, local_id, actor_id=actor_id, client=client)

    assert profile.supabase_user_id == old_id
    client.admin_delete_user.assert_called_once_with(replacement_id)
    client.admin_send_invitation.assert_not_called()
    db.commit.assert_not_called()
