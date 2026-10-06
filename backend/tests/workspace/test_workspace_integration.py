import os
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.systems.manage.audit.models import AuditLog
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.manage.workspace.models import WorkspaceProfile

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def _profile(session: Session) -> WorkspaceProfile:
    profile = session.scalar(
        select(WorkspaceProfile).where(WorkspaceProfile.singleton_key.is_(True))
    )
    assert isinstance(profile, WorkspaceProfile)
    return profile


def test_workspace_migration_seeds_neutral_singleton(integration_owner_db: Session) -> None:
    profile = _profile(integration_owner_db)

    assert profile.display_name == "OpenSlate"
    assert profile.timezone == "UTC"
    assert profile.locale == "en-US"
    assert profile.revision == 1


def test_workspace_migration_preserves_designed_settings_defaults(
    integration_owner_db: Session,
) -> None:
    profile = _profile(integration_owner_db)

    assert profile.currency == "PHP"
    assert profile.week_start == "monday"
    assert profile.business_hours == "09:00–18:00"
    assert profile.mark == "RS"
    assert profile.theme == "slate"
    assert profile.session_timeout_minutes == 60
    assert profile.password_min_length == 12
    assert profile.password_require_mixed_case is True
    assert profile.password_require_number is False
    assert not any(
        (profile.mfa_require_admin, profile.mfa_require_member, profile.mfa_require_guest)
    )
    assert profile.ip_allow_list == []


@pytest.mark.parametrize(
    "field,value",
    [
        ("currency", "php"),
        ("week_start", "friday"),
        ("business_hours", " padded "),
        ("mark", " padded "),
        ("theme", "sepia"),
        ("theme", None),
        ("session_timeout_minutes", 20),
        ("password_min_length", 11),
        ("password_min_length", 129),
        ("mfa_grace_days", 31),
        ("ip_allow_list", {}),
    ],
)
def test_workspace_settings_reject_invalid_persisted_values(
    integration_owner_db: Session, field: str, value: object
) -> None:
    profile = _profile(integration_owner_db)
    setattr(profile, field, value)

    with pytest.raises(IntegrityError):
        integration_owner_db.flush()


def test_workspace_singleton_constraint_rejects_second_profile(
    integration_owner_db: Session,
) -> None:
    integration_owner_db.add(
        WorkspaceProfile(
            display_name="Second profile",
            timezone="UTC",
            locale="en-US",
        )
    )

    with pytest.raises(IntegrityError):
        integration_owner_db.flush()


def test_workspace_singleton_cannot_be_soft_deleted(integration_owner_db: Session) -> None:
    profile = _profile(integration_owner_db)
    profile.is_deleted = True
    profile.deleted_at = datetime.now(UTC)

    with pytest.raises(IntegrityError):
        integration_owner_db.flush()


def test_workspace_audit_redacts_contact_values(integration_owner_db: Session) -> None:
    profile = _profile(integration_owner_db)
    secret_email = "sensitive-contact@example.com"
    profile.contact_email = secret_email

    integration_owner_db.flush()

    audit_row = integration_owner_db.scalar(
        select(AuditLog)
        .where(AuditLog.entity_id == profile.id)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    )
    assert isinstance(audit_row, AuditLog)
    assert audit_row.after == {"contact_email": REDACTED}
    assert secret_email not in str(audit_row.before)
    assert secret_email not in str(audit_row.after)
