"""Run the retention sweep inside a test's rolled-back transaction, as the session's role."""

from collections.abc import Callable
from datetime import datetime
from secrets import randbits
from uuid import UUID

import pytest
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.database.organization_scope import worker_organization
from app.core.database.session import AuditSession
from app.systems.platform.scheduling import retention
from tests.rbac.support import organization

# Today, because the fixtures' own notifications and runs are stamped with the real clock.
NOW = utc_now()


def uuid7_at(moment: datetime) -> UUID:
    """A UUIDv7 of ``moment``; the application's ids carry their creation time this way."""

    milliseconds = int(moment.timestamp() * 1000)
    return UUID(int=(milliseconds << 80) | (0x7 << 76) | (0b10 << 62) | randbits(62))


def sweep(
    db: Session,
    monkeypatch: pytest.MonkeyPatch,
    *,
    now: datetime = NOW,
    stopping: Callable[[], bool] = lambda: False,
) -> None:
    """One wake for the test's organization; each batch commits a savepoint of ``db``."""

    db.flush()
    connection = db.connection()
    with monkeypatch.context() as patched:
        patched.setattr(
            retention,
            "AuditSession",
            lambda _engine: AuditSession(bind=connection, join_transaction_mode="create_savepoint"),
        )
        with worker_organization(organization(db).id):
            retention.sweep_organization(connection.engine, now=now, stopping=stopping)
    db.expire_all()
