"""Report audience storage contracts on runner-owned PostgreSQL."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.access.users.models import Role, User, UserStatus
from app.systems.openview.reports.models import Report
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.exceptions import LifecyclePlanDriftError
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.modules.models import Module
from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

pytestmark = pytest.mark.integration
SOURCE_REVISION = "18958e485e0c"
TARGET_REVISION = "d3c2ce550d4a"


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


def test_report_audience_migration_backfills_private_and_preserves_legacy_rows() -> None:
    environment = guarded_migration_environment()
    engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    user_id, department_id, module_id, active_id, archived_id = (uuid7() for _ in range(5))
    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with engine.begin() as connection:
            role_id = connection.scalar(text("SELECT id FROM roles WHERE role = 'member'"))
            assert role_id is not None
            connection.execute(
                text(
                    "INSERT INTO users (id, email, username, status, role_id) "
                    "VALUES (:id, :email, :username, 'active', :role_id)"
                ),
                {
                    "id": user_id,
                    "email": f"report-audience-migrate-{user_id.hex}@example.test",
                    "username": f"report_audience_migrate_{user_id.hex[:8]}",
                    "role_id": role_id,
                },
            )
            connection.execute(
                text("INSERT INTO departments (id, department_name) VALUES (:id, :name)"),
                {"id": department_id, "name": "Report audience legacy source"},
            )
            connection.execute(
                text(
                    "INSERT INTO modules (id, department_id, module_name) "
                    "VALUES (:id, :department_id, 'Report audience legacy module')"
                ),
                {"id": module_id, "department_id": department_id},
            )
            for report_id, archived in ((active_id, False), (archived_id, True)):
                connection.execute(
                    text(
                        "INSERT INTO reports "
                        "(id, owner_id, module_id, name, revision, recipe, is_deleted, deleted_at) "
                        "VALUES (:id, :owner_id, :module_id, :name, 7, "
                        "'{\"version\": 1}'::jsonb, :is_deleted, :deleted_at)"
                    ),
                    {
                        "id": report_id,
                        "owner_id": user_id,
                        "module_id": module_id,
                        "name": "Archived legacy" if archived else "Active legacy",
                        "is_deleted": archived,
                        "deleted_at": datetime.now(UTC) if archived else None,
                    },
                )

        run_alembic(environment, "upgrade", TARGET_REVISION)
        with engine.connect() as connection:
            rows = (
                connection.execute(
                    text(
                        "SELECT id, owner_id, module_id, name, revision, recipe, is_deleted, "
                        "audience_kind, audience_role_id, audience_user_id "
                        "FROM reports WHERE id IN (:active_id, :archived_id) ORDER BY name"
                    ),
                    {"active_id": active_id, "archived_id": archived_id},
                )
                .mappings()
                .all()
            )
            assert len(rows) == 2
            assert {row["audience_kind"] for row in rows} == {"private"}
            assert all(
                row["audience_role_id"] is None and row["audience_user_id"] is None for row in rows
            )
            assert all(row["owner_id"] == user_id and row["module_id"] == module_id for row in rows)
            assert all(row["revision"] == 7 and row["recipe"] == {"version": 1} for row in rows)
            assert {row["is_deleted"] for row in rows} == {False, True}
            constraints = dict(
                connection.execute(
                    text(
                        "SELECT conname, contype FROM pg_constraint "
                        "WHERE conrelid = 'public.reports'::regclass "
                        "AND conname IN ('ck_reports_audience', "
                        "'fk_reports_audience_role_id_roles', 'fk_reports_audience_user_id_users')"
                    )
                ).all()
            )
            assert constraints == {
                "ck_reports_audience": "c",
                "fk_reports_audience_role_id_roles": "f",
                "fk_reports_audience_user_id_users": "f",
            }

        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with engine.connect() as connection:
            assert (
                connection.scalar(
                    text("SELECT COUNT(*) FROM reports WHERE id IN (:a, :b)"),
                    {"a": active_id, "b": archived_id},
                )
                == 2
            )
            assert (
                connection.scalar(
                    text(
                        "SELECT COUNT(*) FROM information_schema.columns "
                        "WHERE table_schema='public' AND table_name='reports' "
                        "AND column_name LIKE 'audience_%'"
                    )
                )
                == 0
            )
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
        finally:
            with engine.begin() as connection:
                connection.execute(
                    text("DELETE FROM reports WHERE id IN (:a, :b)"),
                    {"a": active_id, "b": archived_id},
                )
                connection.execute(text("DELETE FROM modules WHERE id = :id"), {"id": module_id})
                connection.execute(
                    text("DELETE FROM departments WHERE id = :id"), {"id": department_id}
                )
                connection.execute(text("DELETE FROM users WHERE id = :id"), {"id": user_id})
            engine.dispose()
