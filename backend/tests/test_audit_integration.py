import os
from collections.abc import Generator
from uuid import uuid7

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.core.database.base import Base
from app.core.database.session import AuditSession
from app.systems.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.audit.models import AuditAction, AuditLog
from app.systems.users.models import Role, User

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(
    TEST_DATABASE_URL is None,
    reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
)


@pytest.fixture
def db() -> Generator[Session, None, None]:
    assert TEST_DATABASE_URL is not None
    engine = create_engine(TEST_DATABASE_URL)
    Base.metadata.create_all(engine)
    connection = engine.connect()
    transaction = connection.begin()
    session = AuditSession(bind=connection)
    session.info[AUDIT_CONTEXT_KEY] = AuditContext(
        request_id=uuid7(),
        request_method="POST",
        request_path="/api/test",
    )
    try:
        yield session
    finally:
        session.close()
        if transaction.is_active:
            transaction.rollback()
        connection.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def audit_rows(session: Session, user_id) -> list[AuditLog]:
    return list(
        session.scalars(
            select(AuditLog)
            .where(AuditLog.entity_id == user_id)
            .order_by(AuditLog.created_at, AuditLog.id)
        ).all()
    )


def test_crud_changes_are_audited_with_minimal_snapshots(db: Session) -> None:
    role = Role(role="member-test-crud", permissions={})
    db.add(role)
    db.flush()
    user = User(
        username="integration-user",
        password_hash="hash",
        role_id=role.id,
    )
    db.add(user)
    db.flush()

    user.username = "integration-user-updated"
    db.flush()

    user.is_deleted = True
    db.flush()

    rows = audit_rows(db, user.id)
    assert [row.action for row in rows] == [
        AuditAction.CREATE,
        AuditAction.UPDATE,
        AuditAction.DELETE,
    ]
    assert rows[0].after["password_hash"] == "[REDACTED]"
    assert rows[1].before == {"username": "integration-user"}
    assert rows[1].after == {"username": "integration-user-updated"}
    assert rows[2].before["is_deleted"] is False
    assert rows[2].after["is_deleted"] is True
    assert all(row.performed_by is None for row in rows)


def test_rollback_does_not_keep_audit_rows(db: Session) -> None:
    role = Role(role="member-test-rollback", permissions={})
    db.add(role)
    db.flush()
    user = User(username="rollback-user", password_hash="hash", role_id=role.id)
    db.add(user)
    db.flush()
    user_id = user.id

    assert len(audit_rows(db, user_id)) == 1
    db.rollback()

    assert db.get(User, user_id) is None


def test_hard_delete_records_the_previous_state(db: Session) -> None:
    role = Role(role="member-test-delete", permissions={})
    db.add(role)
    db.flush()
    user = User(username="hard-delete-user", password_hash="hash", role_id=role.id)
    db.add(user)
    db.flush()
    user_id = user.id

    db.delete(user)
    db.flush()

    rows = audit_rows(db, user_id)
    assert [row.action for row in rows] == [AuditAction.CREATE, AuditAction.DELETE]
    assert rows[-1].before["username"] == "hard-delete-user"
    assert db.get(User, user_id) is None
