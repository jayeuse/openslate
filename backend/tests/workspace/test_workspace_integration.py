import os
from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.systems.audit.models import AuditLog
from app.systems.audit.snapshots import REDACTED
from app.systems.workspace.models import WorkspaceProfile

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
