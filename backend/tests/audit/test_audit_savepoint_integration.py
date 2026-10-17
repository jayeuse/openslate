"""Savepoints cannot broadcast or discard another item's staged invalidations."""

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.manage.audit.listeners import REALTIME_INVALIDATION_KEY
from app.systems.platform.events.models import InvalidationEvent
from app.systems.sandbox.departments.models import Department
from tests.rbac.support import organization

pytestmark = pytest.mark.integration


def test_savepoint_release_waits_for_outer_commit_and_rollback_keeps_prior_successes(
    integration_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = integration_db
    org = organization(db)
    db.commit()
    published: list[InvalidationEvent] = []
    monkeypatch.setattr(
        "app.systems.manage.audit.listeners.publish_invalidations", published.extend
    )
    first = Department(org_id=org.id, department_name=f"First {uuid7()}")
    db.add(first)
    db.flush()
    with db.begin_nested():
        db.add(Department(org_id=org.id, department_name=f"Second {uuid7()}"))
        db.flush()
    assert published == []
    assert db.info[REALTIME_INVALIDATION_KEY]
    before = list(db.info[REALTIME_INVALIDATION_KEY])

    def add_then_reject() -> None:
        db.add(Department(org_id=org.id, department_name=f"Rejected {uuid7()}"))
        db.flush()
        raise ValueError("reject owned item")

    with pytest.raises(ValueError, match="reject owned item"), db.begin_nested():
        add_then_reject()
    assert published == []
    assert db.info[REALTIME_INVALIDATION_KEY] == before
    with db.begin_nested():
        with db.begin_nested():
            db.add(Department(org_id=org.id, department_name=f"Last {uuid7()}"))
            db.flush()
    assert published == []
    db.commit()
    assert published == [
        InvalidationEvent("departments", all_authenticated=True, org_id=org.id)
    ]
    assert REALTIME_INVALIDATION_KEY not in db.info


def test_outer_rollback_after_successful_savepoints_publishes_nothing(
    integration_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = integration_db
    org = organization(db)
    db.commit()
    published: list[InvalidationEvent] = []
    monkeypatch.setattr(
        "app.systems.manage.audit.listeners.publish_invalidations", published.extend
    )
    with db.begin_nested():
        db.add(Department(org_id=org.id, department_name=f"Outer rollback {uuid7()}"))
        db.flush()
    assert published == []
    db.rollback()
    assert published == []
    assert REALTIME_INVALIDATION_KEY not in db.info
