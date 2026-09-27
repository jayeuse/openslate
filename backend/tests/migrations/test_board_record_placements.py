"""Board placement schema and privilege contracts on the fresh baseline."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import Connection
from uuid6 import uuid7

from app.systems.access.users.models import Role, User
from app.systems.boards.models import Board
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record

SUPABASE_DATABASE_ROLES = ("anon", "authenticated", "service_role")
TABLE_ACTIONS = ("SELECT", "INSERT", "UPDATE", "DELETE")
PLACEMENTS_TABLE = "public.board_record_placements"


@pytest.mark.integration
def test_board_placement_baseline_preserves_schema_and_application_role_boundaries(
    integration_owner_db,
    integration_db,
) -> None:
    # Source-head data preservation and downgrade transitions are archived with the old chain.
    connection = integration_owner_db.connection()
    assert connection.scalar(text("SELECT to_regclass(:table)"), {"table": PLACEMENTS_TABLE})
    _assert_placement_schema_and_privileges(connection)
    _assert_runtime_role_can_create_and_read_placements(integration_db)


def _assert_placement_schema_and_privileges(connection: Connection) -> None:
    constraints = {
        row["conname"]: row
        for row in connection.execute(
            text(
                "SELECT conname, contype, confdeltype FROM pg_constraint "
                "WHERE conrelid = CAST(:table AS regclass)"
            ),
            {"table": PLACEMENTS_TABLE},
        ).mappings()
    }
    assert constraints["uq_board_record_placements_board_record"]["contype"] == "u"
    assert constraints["fk_board_record_placements_board_id_boards"]["confdeltype"] == "r"
    assert constraints["fk_board_record_placements_record_id_records"]["confdeltype"] == "r"
    assert constraints["fk_board_record_placements_performed_by_users"]["confdeltype"] == "n"
    assert (
        connection.scalar(
            text(
                "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' "
                "AND tablename = 'board_record_placements' "
                "AND indexname = 'ix_board_record_placements_record_id'"
            )
        )
        == 1
    )
    for action in TABLE_ACTIONS:
        assert (
            connection.scalar(
                text("SELECT has_table_privilege('openslate_runtime', :table, :action)"),
                {"table": PLACEMENTS_TABLE, "action": action},
            )
            is True
        )
    for role in SUPABASE_DATABASE_ROLES:
        for action in TABLE_ACTIONS:
            assert (
                connection.scalar(
                    text("SELECT has_table_privilege(:role, :table, :action)"),
                    {"role": role, "table": PLACEMENTS_TABLE, "action": action},
                )
                is False
            ), f"Supabase database role {role} must not access board_record_placements"


def _assert_runtime_role_can_create_and_read_placements(db) -> None:
    role = db.scalar(select(Role).where(Role.role == "member"))
    assert role is not None
    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"placement-baseline-{user_id.hex}@example.test",
        username=f"placement_baseline_{user_id.hex[:12]}",
        status="active",
        role_id=role.id,
    )
    department = Department(department_name=f"Placement baseline {uuid7().hex}")
    db.add_all([user, department])
    db.flush()

    module = Module(department_id=department.id, module_name="Placement baseline")
    board = Board(owner_id=user.id, department_id=department.id, name="Placement baseline")
    db.add_all([module, board])
    db.flush()
    record = Record(module_id=module.id)
    db.add(record)
    db.flush()

    placement_id = uuid7()
    db.connection().execute(
        text(
            "INSERT INTO public.board_record_placements "
            "(id, board_id, record_id, performed_by) "
            "VALUES (:id, :board_id, :record_id, :performed_by)"
        ),
        {
            "id": placement_id,
            "board_id": board.id,
            "record_id": record.id,
            "performed_by": user.id,
        },
    )
    assert db.connection().execute(
        text(
            "SELECT board_id, record_id, performed_by "
            "FROM public.board_record_placements WHERE id = :id"
        ),
        {"id": placement_id},
    ).one() == (board.id, record.id, user.id)
