"""Board template persistence and audit boundaries on disposable PostgreSQL."""

import json
from uuid import UUID

import pytest
from sqlalchemy import insert, select, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import IntegrityError
from uuid6 import uuid7

from app.systems.boards.portability import parse_portable_board
from app.systems.boards.template_models import BoardTemplate
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.conftest import guarded_create_engine
from tests.operations.migration_support import guarded_migration_environment, run_alembic

SOURCE_REVISION = "f192c8e85248"
TARGET_REVISION = "1d9ef36b7646"
ACCESS_HEAD_REVISION = "2bf95b237416"


def _bundle(filter_value: str) -> dict[str, object]:
    return {
        "kind": "openslate-board",
        "version": 2,
        "configuration": {
            "name": "Reusable board",
            "description": None,
            "department_name": None,
            "default_section": "overview",
            "widgets": [
                {
                    "name": "Requests",
                    "widget_type": "records",
                    "source": {"department_name": "Operations", "module_name": "Requests"},
                    "config": {
                        "fields": [],
                        "filters": [
                            {
                                "name": "Reference",
                                "expected_type": "text",
                                "operator": "eq",
                                "value": filter_value,
                            }
                        ],
                        "logic": "and",
                        "metric": None,
                        "visualization": "bar",
                        "size": "half",
                        "refresh": "manual",
                        "pinned": False,
                    },
                }
            ],
        },
    }


@pytest.mark.integration
def test_template_persists_full_v2_bundle_without_leaking_filter_values_to_audit(
    integration_db,
) -> None:
    first = _bundle("private-first-filter")
    assert parse_portable_board(json.dumps(first).encode()).version == 2
    template = BoardTemplate(name="Requests starter", bundle=first)
    integration_db.add(template)
    integration_db.commit()

    stored = integration_db.get(BoardTemplate, template.id)
    assert stored is not None
    assert stored.bundle == first
    created = integration_db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "board_templates",
            AuditLog.entity_id == template.id,
            AuditLog.action == AuditAction.CREATE,
        )
    )
    assert created is not None
    assert created.after is not None
    assert created.after["bundle"] == "[REDACTED]"

    stored.bundle = _bundle("private-second-filter")
    integration_db.commit()
    updated = integration_db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "board_templates",
            AuditLog.entity_id == template.id,
            AuditLog.action == AuditAction.UPDATE,
        )
    )
    assert updated is not None
    assert updated.before == {"bundle": "[REDACTED]"}
    assert updated.after == {"bundle": "[REDACTED]"}


@pytest.mark.integration
def test_template_migration_adds_safe_schema_and_least_privilege_roles() -> None:
    environment = guarded_migration_environment()
    owner_engine = guarded_create_engine(environment["MIGRATION_DATABASE_URL"])
    runtime_engine = guarded_create_engine(environment["TEST_DATABASE_URL"])
    inspector_engine = guarded_create_engine(environment["TEST_INSPECTOR_DATABASE_URL"])
    template_id = uuid7()

    try:
        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            assert connection.scalar(text("SELECT to_regclass('public.board_templates')")) is None
            assert (
                connection.scalar(text("SELECT to_regclass('public.report_schedules')")) is not None
            )

        run_alembic(environment, "upgrade", TARGET_REVISION)
        with owner_engine.connect() as connection:
            applied_revisions = set(
                connection.scalars(text("SELECT version_num FROM alembic_version"))
            )
            assert applied_revisions == {ACCESS_HEAD_REVISION, TARGET_REVISION}
            _assert_template_schema_and_privileges(connection)

        with runtime_engine.begin() as connection:
            connection.execute(
                insert(BoardTemplate).values(
                    id=template_id, name="Shared starter", bundle=_bundle("private-filter")
                )
            )
        with inspector_engine.connect() as connection:
            stored = connection.execute(
                text("SELECT name, bundle FROM public.board_templates WHERE id = :id"),
                {"id": template_id},
            ).one()
            assert stored == ("Shared starter", _bundle("private-filter"))

        with pytest.raises(IntegrityError), runtime_engine.begin() as connection:
            connection.execute(
                insert(BoardTemplate).values(name="   ", bundle=_bundle("invalid name"))
            )

        run_alembic(environment, "downgrade", SOURCE_REVISION)
        with owner_engine.connect() as connection:
            assert connection.scalar(text("SELECT to_regclass('public.board_templates')")) is None
            assert (
                connection.scalar(text("SELECT to_regclass('public.report_schedules')")) is not None
            )
    finally:
        try:
            run_alembic(environment, "upgrade", "head")
            _delete_template_if_present(owner_engine, template_id)
        finally:
            inspector_engine.dispose()
            runtime_engine.dispose()
            owner_engine.dispose()


def _assert_template_schema_and_privileges(connection: Connection) -> None:
    constraints = {
        row.conname: (row.contype, row.confdeltype)
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype FROM pg_constraint "
                "WHERE conrelid = 'public.board_templates'::regclass"
            )
        )
    }
    assert constraints["ck_board_templates_name_nonempty"][0] == "c"
    assert constraints["fk_board_templates_performed_by_users"] == ("f", "n")
    assert constraints["board_templates_pkey"][0] == "p"
    for action in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert (
            connection.scalar(
                text("SELECT has_table_privilege('openslate_runtime', :table, :action)"),
                {"table": "public.board_templates", "action": action},
            )
            is True
        )
    assert (
        connection.scalar(
            text("SELECT has_table_privilege('openslate_inspector', :table, 'SELECT')"),
            {"table": "public.board_templates"},
        )
        is True
    )
    for action in ("INSERT", "UPDATE", "DELETE"):
        assert (
            connection.scalar(
                text("SELECT has_table_privilege('openslate_inspector', :table, :action)"),
                {"table": "public.board_templates", "action": action},
            )
            is False
        )


def _delete_template_if_present(engine: Engine, template_id: UUID) -> None:
    with engine.begin() as connection:
        if connection.scalar(text("SELECT to_regclass('public.board_templates')")) is not None:
            connection.execute(
                text("DELETE FROM public.board_templates WHERE id = :id"),
                {"id": template_id},
            )
