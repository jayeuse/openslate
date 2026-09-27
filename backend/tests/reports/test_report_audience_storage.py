"""Current Report audience and lifecycle contracts on runner-owned PostgreSQL."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.access.users.models import Role, User, UserStatus
from app.systems.openview.reports.models import Report
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import LifecyclePlanDriftError
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.modules.models import Module

pytestmark = pytest.mark.integration


def _source(db) -> tuple[User, Module]:
    role = db.scalar(select(Role).where(Role.role == "member"))
    assert role is not None
    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"report-audience-{user_id.hex}@example.test",
        username=f"report_audience_{user_id.hex[:12]}",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
    )
    department = Department(department_name=f"Report audience {uuid7()}")
    db.add_all([user, department])
    db.flush()
    module = Module(department_id=department.id, module_name="Report audience source")
    db.add(module)
    db.flush()
    return user, module


def test_report_audience_database_accepts_only_exclusive_restrictive_targets(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    owner, module = _source(db)

    for kind, role_id, user_id in (
        ("private", None, None),
        ("everyone", None, None),
        ("role", owner.role_id, None),
        ("user", None, owner.id),
    ):
        report = Report(
            owner_id=owner.id,
            module_id=module.id,
            name=f"Audience {kind}",
            recipe={"version": 1},
            audience_kind=kind,
            audience_role_id=role_id,
            audience_user_id=user_id,
        )
        db.add(report)
        db.flush()
        assert report.audience_kind == kind

    implicit_private = Report(
        owner_id=owner.id,
        module_id=module.id,
        name="Legacy caller default",
        recipe={"version": 1},
    )
    db.add(implicit_private)
    db.flush()
    assert implicit_private.audience_kind == "private"

    for kind, role_id, user_id in (
        ("private", owner.role_id, None),
        ("everyone", None, owner.id),
        ("role", None, None),
        ("role", owner.role_id, owner.id),
        ("user", None, None),
        ("unknown", None, None),
        ("role", uuid7(), None),
        ("user", None, uuid7()),
    ):
        with pytest.raises(IntegrityError):
            with db.begin_nested():
                db.add(
                    Report(
                        owner_id=owner.id,
                        module_id=module.id,
                        name="Rejected audience",
                        recipe={"version": 1},
                        audience_kind=kind,
                        audience_role_id=role_id,
                        audience_user_id=user_id,
                    )
                )
                db.flush()


def test_report_audience_change_invalidates_existing_module_purge_preview(
    integration_owner_db,
) -> None:
    db = integration_owner_db
    owner, module = _source(db)
    now = datetime.now(UTC)
    module.is_deleted = True
    module.deleted_at = now
    report = Report(
        owner_id=owner.id,
        module_id=module.id,
        name="Retained report",
        recipe={"version": 1},
        audience_kind="role",
        audience_role_id=owner.role_id,
        is_deleted=True,
        deleted_at=now,
    )
    db.add(report)
    db.commit()

    preview = plan_lifecycle(db, "module", module.id, "purge", owner.id)
    assert any(blocker.entity_id == report.id for blocker in preview.blockers)
    original_fingerprint = next(
        row.state_fingerprint for row in preview.rows if row.entity_id == report.id
    )
    report.audience_kind = "user"
    report.audience_role_id = None
    report.audience_user_id = owner.id
    db.commit()

    current = plan_lifecycle(db, "module", module.id, "purge", owner.id)
    assert next(row.state_fingerprint for row in current.rows if row.entity_id == report.id) != (
        original_fingerprint
    )
    with pytest.raises(LifecyclePlanDriftError):
        execute_lifecycle(db, preview)
    assert db.get(Report, report.id) is not None
