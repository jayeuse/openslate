"""Board template persistence and audit boundaries on disposable PostgreSQL."""

import json

import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError

from app.systems.boards.portability import parse_portable_board
from app.systems.boards.template_models import BoardTemplate
from app.systems.manage.audit.models import AuditAction, AuditLog

SUPABASE_DATABASE_ROLES = ("anon", "authenticated", "service_role")
TABLE_ACTIONS = ("SELECT", "INSERT", "UPDATE", "DELETE")


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
def test_template_baseline_is_safe_and_readable_by_runtime_role(
    integration_owner_db,
    integration_db,
) -> None:
    # The old table-creation transition is archived; prove current schema and runtime access.
    connection = integration_owner_db.connection()
    assert connection.scalar(text("SELECT to_regclass('public.board_templates')")) is not None
    _assert_template_schema_and_privileges(connection)

    template = BoardTemplate(name="Shared starter", bundle=_bundle("private-filter"))
    integration_db.add(template)
    integration_db.flush()
    stored_name = integration_db.scalar(
        select(BoardTemplate.name).where(BoardTemplate.id == template.id)
    )
    assert stored_name == "Shared starter"

    with pytest.raises(IntegrityError):
        with integration_db.begin_nested():
            integration_db.add(BoardTemplate(name="   ", bundle=_bundle("invalid name")))
            integration_db.flush()


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
    for action in TABLE_ACTIONS:
        assert (
            connection.scalar(
                text("SELECT has_table_privilege('openslate_runtime', :table, :action)"),
                {"table": "public.board_templates", "action": action},
            )
            is True
        )
    for role in SUPABASE_DATABASE_ROLES:
        for action in TABLE_ACTIONS:
            assert (
                connection.scalar(
                    text("SELECT has_table_privilege(:role, :table, :action)"),
                    {"role": role, "table": "public.board_templates", "action": action},
                )
                is False
            ), f"Supabase database role {role} must not access board_templates"
