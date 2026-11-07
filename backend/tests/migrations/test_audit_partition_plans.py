"""Plans of the audit list on the partitioned table, as the runtime reads them (K10, K11).

Pages and plan shape only, with parallel workers off (plan rules 9 and 10). The statements
come from the real list service and are replayed in a runtime session.
"""

import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import pytest
from fastapi import HTTPException, Response
from sqlalchemy import Connection, event, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from app.common.listing import StandardListRequest
from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User, UserRole
from app.systems.boards.activity_router import list_board_activity
from app.systems.boards.activity_schemas import BoardActivityListRequest
from app.systems.comms.settings import history_replay
from app.systems.comms.settings.models import CommsSettings
from app.systems.manage.audit.models import AuditAction
from app.systems.manage.audit.service import AuditLogSortField, list_audit_logs
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge
from tests.boards.support import project_board
from tests.conftest import alembic_heads, create_member, guarded_create_engine
from tests.database_pool import dispose_process_engines
from tests.migrations.audit_partition_support import (
    AuditEngines,
    month_starts,
    partition_name,
)
from tests.migrations.audit_partition_support import (
    audit_engines as audit_engines,
)
from tests.operations.migration_support import guarded_migration_environment, run_alembic
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration

ROWS_PER_MONTH = 8_000
SMALL_ROWS_PER_MONTH = 10
# A small organization's list reads 15 pages here; without an index that leads with org_id,
# each statement reads all the pages of the three loaded months, which is about 1,400.
SMALL_ORGANIZATION_PAGE_CEILING = 60
# More audit entries than links, as on a real installation: each link has a long history.
LINKS = 300
LINK_ENTRIES = 9_000
# The department's other entries, which have no link to look for.
OTHER_ENTRIES = 9_000
FEW_MONTHS, MANY_MONTHS = 2, 6
LINK_TABLES = {"relationship_edges", "records"}
PARENT_INDEX = {
    "department_id": "ix_audit_logs_department_created_at_id",
    "performed_by": "ix_audit_logs_actor",
    "request_id": "ix_audit_logs_request",
    "action": "ix_audit_logs_action",
}


@dataclass(frozen=True)
class _Plans:
    engines: AuditEngines
    large: UUID
    small: UUID
    large_admin: UUID
    small_admin: UUID
    actor: UUID
    department: UUID
    request_id: UUID
    months: list[str]

    @property
    def leaves(self) -> list[str]:
        return [partition_name(first_day) for first_day in self.months]


def _add_organization(connection: Connection) -> UUID:
    org_id = uuid7()
    connection.execute(
        WorkspaceProfile.__table__.insert().values(
            id=org_id, slug=f"plans-{org_id}", display_name="Plans", timezone="UTC",
            locale="en-US",
        )
    )
    return org_id


def _load_month(connection: Connection, world: dict[str, Any], first_day: str) -> None:
    # About 1 row in 100 matches each selective filter, so an index is the plan to expect.
    connection.execute(
        text(
            "INSERT INTO public.audit_logs (id, org_id, created_at, performed_by, action, "
            "entity_type, entity_id, department_id, request_id, after) "
            "SELECT gen_random_uuid(), :large, CAST(:first_day AS timestamptz) "
            "  + make_interval(mins => step), "
            "  CASE WHEN step % 100 = 0 THEN CAST(:actor AS uuid) END, "
            "  CASE WHEN step % 100 = 1 THEN 'delete' ELSE 'update' END, 'records', "
            "  gen_random_uuid(), "
            "  CASE WHEN step % 100 = 2 THEN CAST(:department AS uuid) "
            "       WHEN step % 3 = 0 THEN gen_random_uuid() END, "
            "  CASE WHEN step % 100 = 3 THEN CAST(:request_id AS uuid) "
            "       ELSE gen_random_uuid() END, "
            "  jsonb_build_object('padding', repeat('x', 300)) "
            "FROM generate_series(1, :rows) AS step"
        ),
        {**world, "first_day": first_day, "rows": ROWS_PER_MONTH},
    )
    connection.execute(
        text(
            "INSERT INTO public.audit_logs (id, org_id, created_at, action, entity_type) "
            "SELECT gen_random_uuid(), :small, "
            "  CAST(:first_day AS timestamptz) + make_interval(hours => step), "
            "  'create', 'records' FROM generate_series(1, :rows) AS step"
        ),
        {**world, "first_day": first_day, "rows": SMALL_ROWS_PER_MONTH},
    )


@pytest.fixture
def plans(audit_engines: AuditEngines) -> Iterator[_Plans]:
    with AuditSession(bind=audit_engines.owner, expire_on_commit=False) as setup:
        connection = setup.connection()
        large, small = _add_organization(connection), _add_organization(connection)
        large_org, small_org = setup.get_one(WorkspaceProfile, large), setup.get_one(
            WorkspaceProfile, small
        )
        name = uuid7().hex
        large_admin, _member = create_member(
            setup, large_org, UserRole.ADMIN.value,
            email=f"plans-large-{name}@example.test", username=f"plans-large-{name}",
        )
        small_admin, _member = create_member(
            setup, small_org, UserRole.ADMIN.value,
            email=f"plans-small-{name}@example.test", username=f"plans-small-{name}",
        )
        setup.commit()
        large_admin_id, small_admin_id = large_admin.id, small_admin.id
    world = {
        "large": large,
        "small": small,
        "actor": large_admin_id,
        "department": uuid7(),
        "request_id": uuid7(),
    }
    with audit_engines.owner.begin() as connection:
        months = month_starts(connection)
        for first_day in months:
            _load_month(connection, world, first_day)
        connection.execute(text("ANALYZE public.audit_logs"))
    try:
        yield _Plans(
            audit_engines, large, small, large_admin_id, small_admin_id, world["actor"],
            world["department"], world["request_id"], months,
        )
    finally:
        ids = {"large": large, "small": small, "users": [large_admin_id, small_admin_id]}
        with audit_engines.owner.begin() as connection:
            connection.execute(
                text("DELETE FROM public.audit_logs WHERE org_id IN (:large, :small)"), ids
            )
            connection.execute(
                text("DELETE FROM public.memberships WHERE org_id IN (:large, :small)"), ids
            )
            connection.execute(text("DELETE FROM public.users WHERE id = ANY(:users)"), ids)
            connection.execute(
                text("DELETE FROM public.organizations WHERE id IN (:large, :small)"), ids
            )


def _captured_list(
    world: Any, org_id: UUID, reader_id: UUID, **filters: Any
) -> list[dict[str, Any]]:
    """Run the real list, then read the plan of each of its audit statements as the runtime."""

    captured: list[tuple[str, Any]] = []

    def capture(_connection, _cursor, statement, parameters, _context, _many) -> None:
        if "FROM audit_logs" in statement and not statement.startswith("EXPLAIN"):
            captured.append((statement, parameters))

    runtime = world.engines.runtime
    with AuditSession(bind=runtime) as db:
        scope_session(db, org_id)
        reader = db.get_one(User, reader_id)
        event.listen(runtime, "before_cursor_execute", capture)
        try:
            list_audit_logs(
                db,
                StandardListRequest[AuditLogSortField](sort_by=AuditLogSortField.CREATED_AT),
                reader=reader,
                **filters,
            )
        finally:
            event.remove(runtime, "before_cursor_execute", capture)
        assert captured
        cursor = db.connection().connection.cursor()
        cursor.execute("SET LOCAL max_parallel_workers_per_gather = 0")
        plans = []
        for statement, parameters in captured:
            cursor.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement, parameters)
            plans.append(cursor.fetchone()[0][0]["Plan"])
        db.rollback()
    return plans


def _nodes(plan: dict[str, Any]) -> Iterator[dict[str, Any]]:
    yield plan
    for child in plan.get("Plans", ()):
        yield from _nodes(child)


def _pages(plan: dict[str, Any]) -> int:
    # Buffers count each page visit, warm or cold, so the number does not depend on the cache.
    return int(plan["Shared Hit Blocks"]) + int(plan["Shared Read Blocks"])


def _child_indexes(world: _Plans, parent_index: str) -> dict[str, str]:
    """The child of `parent_index` on each leaf."""

    with world.engines.owner.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT leaf.relname, child.relname FROM pg_inherits AS link "
                "JOIN pg_class AS child ON child.oid = link.inhrelid "
                "JOIN pg_index AS details ON details.indexrelid = child.oid "
                "JOIN pg_class AS leaf ON leaf.oid = details.indrelid "
                "WHERE link.inhparent = to_regclass(:parent)"
            ),
            {"parent": f"public.{parent_index}"},
        )
        return dict(rows.all())


def test_a_small_organization_reads_a_few_pages_beside_a_large_one_k10(plans: _Plans) -> None:
    world = plans
    with world.engines.owner.connect() as connection:
        loaded_pages = sum(
            connection.scalar(
                text(
                    "SELECT pg_relation_size(to_regclass(:leaf)) "
                    "/ current_setting('block_size')::bigint"
                ),
                {"leaf": f"public.{leaf}"},
            )
            for leaf in world.leaves
        )
    assert loaded_pages > 5 * SMALL_ORGANIZATION_PAGE_CEILING

    statements = _captured_list(world, world.small, world.small_admin)

    pages = [_pages(plan) for plan in statements]
    assert max(pages) <= SMALL_ORGANIZATION_PAGE_CEILING, pages
    scans = [
        node["Relation Name"]
        for plan in statements
        for node in _nodes(plan)
        if node["Node Type"] == "Seq Scan" and node.get("Relation Name") in world.leaves
    ]
    assert scans == []


@pytest.mark.parametrize("name", sorted(PARENT_INDEX))
def test_each_filter_uses_its_index_in_each_loaded_month(plans: _Plans, name: str) -> None:
    world = plans
    filters: dict[str, Any] = {
        "department_id": {"department_id": world.department},
        "performed_by": {"performed_by": world.actor},
        "request_id": {"request_id": world.request_id},
        "action": {"action": AuditAction.DELETE},
    }[name]

    statements = _captured_list(world, world.large, world.large_admin, **filters)

    children = _child_indexes(world, PARENT_INDEX[name])
    for plan in statements:
        nodes = list(_nodes(plan))
        used = {node.get("Index Name") for node in nodes}
        assert {children[leaf] for leaf in world.leaves} <= used, used
        assert [
            node["Relation Name"]
            for node in nodes
            if node["Node Type"] == "Seq Scan" and node.get("Relation Name") in world.leaves
        ] == []


def test_a_date_range_removes_the_other_months(plans: _Plans) -> None:
    world = plans
    first_day = world.months[1]
    statements = _captured_list(
        world,
        world.large,
        world.large_admin,
        created_after=datetime.fromisoformat(f"{first_day}T01:00:00+00:00"),
        created_before=datetime.fromisoformat(f"{first_day}T02:00:00+00:00"),
    )

    for plan in statements:
        touched = {
            node["Relation Name"]
            for node in _nodes(plan)
            if str(node.get("Relation Name", "")).startswith("audit_logs_")
        }
        assert touched == {world.leaves[1]}


@dataclass(frozen=True)
class _LinkHistory:
    engines: AuditEngines
    org: UUID
    manager: UUID
    department: UUID
    edges: list[UUID]
    months: list[str]


@contextmanager
def _committed_history() -> Iterator[AuditEngines]:
    """Engines for rows that a test commits; they leave with `downgrade base`."""

    environment = guarded_migration_environment()
    [head] = alembic_heads()
    dispose_process_engines()
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"], poolclass=NullPool)
    try:
        yield AuditEngines(owner, runtime)
    finally:
        run_alembic(environment, "downgrade", "base")
        run_alembic(environment, "upgrade", head)
        owner.dispose()
        runtime.dispose()


def _create_months(db: Session) -> list[str]:
    """`MANY_MONTHS` partitions first, so that the partition count stays the same."""

    months = month_starts(db.connection(), MANY_MONTHS)
    for first_day in months:
        db.execute(
            text("SELECT public.create_audit_partition(CAST(:day AS date))"), {"day": first_day}
        )
    db.commit()
    return months


@pytest.fixture
def link_history() -> Iterator[_LinkHistory]:
    """A department manager who reads every link."""

    with _committed_history() as engines, Session(
        bind=engines.owner, expire_on_commit=False
    ) as db:
        department = add_department(db)
        module = add_module(db, department)
        manager = add_user(db, role=UserRole.MEMBER)
        make_group_access(db, [manager], department, level=AccessLevel.MANAGE)
        field = Field(
            org_id=department.org_id,
            module_id=module.id,
            name="Link",
            type=FieldType.RELATIONSHIP,
            position=0,
            relationship_target_module_id=module.id,
            relationship_multiple_targets=True,
            relationship_multiple_sources=True,
        )
        source = Record(org_id=department.org_id, module_id=module.id, data={})
        targets = [
            Record(org_id=department.org_id, module_id=module.id, data={})
            for _target in range(LINKS)
        ]
        db.add_all([field, source, *targets])
        db.flush()
        edges = [
            RelationshipEdge(
                org_id=department.org_id,
                field_id=field.id,
                source_record_id=source.id,
                target_record_id=target.id,
            )
            for target in targets
        ]
        db.add_all(edges)
        db.commit()
        months = _create_months(db)
        yield _LinkHistory(
            engines,
            department.org_id,
            manager.id,
            department.id,
            [edge.id for edge in edges],
            months,
        )


def _spread_entries(world: _LinkHistory, month_count: int) -> None:
    """The same audit entries, now over `month_count` months."""

    with world.engines.owner.begin() as connection:
        connection.execute(
            text(
                "DELETE FROM public.audit_logs WHERE org_id = :org "
                "AND entity_type IN ('relationship_edges', 'reports')"
            ),
            {"org": world.org},
        )
        connection.execute(
            text(
                "INSERT INTO public.audit_logs (id, org_id, created_at, action, entity_type, "
                "entity_id, department_id) "
                "SELECT gen_random_uuid(), :org, "
                "  (CAST(:months AS timestamptz[]))[1 + step % :month_count] "
                "  + make_interval(mins => step), 'update', "
                "  CASE WHEN step < :entries THEN 'relationship_edges' ELSE 'reports' END, "
                "  CASE WHEN step < :entries THEN (CAST(:edges AS uuid[]))[1 + step % :links] "
                "       ELSE gen_random_uuid() END, :department "
                "FROM generate_series(0, :entries + :others - 1) AS step"
            ),
            {
                "org": world.org,
                "months": world.months,
                "month_count": month_count,
                "edges": world.edges,
                "links": LINKS,
                "department": world.department,
                "entries": LINK_ENTRIES,
                "others": OTHER_ENTRIES,
            },
        )
        connection.execute(text("ANALYZE public.audit_logs"))


def _link_pages(plan: dict[str, Any]) -> int:
    """The pages that the link check reads; the audit tables do not count."""

    return sum(_pages(node) for node in _nodes(plan) if node.get("Relation Name") in LINK_TABLES)


def test_the_link_check_of_a_member_list_reads_the_same_pages_at_any_month_count(
    link_history: _LinkHistory,
) -> None:
    # REQ-0006: each populated month built its own hash of the link set, so the cost of a
    # manager's list grew with the months. The check runs once for the statement. Pages, not
    # plan shape, because the planner can pick a hash or a probe for each entry.
    world = link_history
    pages = {}
    for month_count in (FEW_MONTHS, MANY_MONTHS):
        _spread_entries(world, month_count)
        statements = _captured_list(
            world, world.org, world.manager, department_id=world.department
        )
        pages[month_count] = max(_link_pages(plan) for plan in statements)

    assert pages[FEW_MONTHS] >= LINKS, pages
    assert pages[MANY_MONTHS] <= pages[FEW_MONTHS] * 5 // 4, pages


# REQ-0007: the rows that each activity reader looks for, and as many that it must skip.
IDENTITIES = 300
IDENTITY_ENTRIES = 9_000
SKIPPED_ENTRIES = 9_000
BOARD_ACTIVITY, SETTINGS_HISTORY = "board activity", "settings history"


@dataclass(frozen=True)
class _ActivityHistory:
    engines: AuditEngines
    org: UUID
    admin: UUID
    board: UUID
    other_board: UUID
    group_rows: list[UUID]
    settings: list[UUID]
    months: list[str]


@pytest.fixture
def activity_history() -> Iterator[_ActivityHistory]:
    """An administrator who reads one Board's activity and the workspace settings history."""

    with _committed_history() as engines, Session(
        bind=engines.owner, expire_on_commit=False
    ) as db:
        admin = add_user(db, role=UserRole.ADMIN)
        board, other_board = project_board(db), project_board(db)
        # A live settings row, so that the identity read of the history has both arms.
        settings = CommsSettings(org_id=board.org_id, scope="workspace", values={})
        db.add(settings)
        db.commit()
        months = _create_months(db)
        yield _ActivityHistory(
            engines,
            board.org_id,
            admin.id,
            board.id,
            other_board.id,
            [uuid7() for _row in range(IDENTITIES)],
            [settings.id, *(uuid7() for _row in range(IDENTITIES - 1))],
            months,
        )


def _spread_activity(world: _ActivityHistory, month_count: int) -> None:
    """The same group and settings entries, now over `month_count` months."""

    spread = (
        "(CAST(:months AS timestamptz[]))[1 + step % :month_count] + make_interval(mins => step)"
    )
    values = {
        "org": world.org,
        "months": world.months,
        "month_count": month_count,
        "entries": IDENTITY_ENTRIES,
        "skipped": SKIPPED_ENTRIES,
        "identities": IDENTITIES,
        "board": str(world.board),
        "other_board": str(world.other_board),
        "group_rows": world.group_rows,
        "settings": world.settings,
    }
    with world.engines.owner.begin() as connection:
        # The pages count audit leaves, so each spread starts on empty leaves. The fixture's
        # `downgrade base` removes every row anyway.
        connection.execute(text("TRUNCATE public.audit_logs"))
        # The other Board's group rows are the rows that the identity read must skip.
        connection.execute(
            text(
                "INSERT INTO public.audit_logs (id, org_id, created_at, action, entity_type, "
                "entity_id, after) "
                f"SELECT gen_random_uuid(), :org, {spread}, 'update', 'board_groups', "
                "  CASE WHEN step < :entries "
                "       THEN (CAST(:group_rows AS uuid[]))[1 + step % :identities] "
                "       ELSE gen_random_uuid() END, "
                "  jsonb_build_object('level', 'read', 'board_id', "
                "    CASE WHEN step < :entries THEN :board ELSE :other_board END) "
                "FROM generate_series(0, :entries + :skipped - 1) AS step"
            ),
            values,
        )
        connection.execute(
            text(
                "INSERT INTO public.audit_logs (id, org_id, created_at, action, entity_type, "
                "entity_id, before, after) "
                f"SELECT gen_random_uuid(), :org, {spread}, 'update', 'comms_settings', "
                "  (CAST(:settings AS uuid[]))[1 + step % :identities], "
                "  '{\"scope\": \"workspace\", \"values\": {}}', "
                "  '{\"scope\": \"workspace\", \"values\": {\"slow_mode_seconds\": 5}}' "
                "FROM generate_series(0, :entries - 1) AS step"
            ),
            values,
        )
        connection.execute(text("ANALYZE public.audit_logs"))


def _read_activity(db: AuditSession, world: _ActivityHistory, reader: str) -> None:
    if reader == BOARD_ACTIVITY:
        list_board_activity(
            world.board, db.get_one(User, world.admin), db, Response(), BoardActivityListRequest()
        )
        return
    # The seeded entries do not replay against the live row. Only their statements count.
    with pytest.raises(HTTPException):
        history_replay.history(db, {"kind": "workspace"})


def _activity_plans(world: _ActivityHistory, reader: str) -> list[dict[str, Any]]:
    """Run the real reader, then read the plan of each of its audit statements as the runtime."""

    captured: list[tuple[str, Any]] = []

    def capture(_connection, _cursor, statement, parameters, _context, _many) -> None:
        if "audit_logs" in statement and not statement.startswith("EXPLAIN"):
            captured.append((statement, parameters))

    runtime = world.engines.runtime
    with AuditSession(bind=runtime) as db:
        scope_session(db, world.org)
        event.listen(runtime, "before_cursor_execute", capture)
        try:
            _read_activity(db, world, reader)
        finally:
            event.remove(runtime, "before_cursor_execute", capture)
        cursor = db.connection().connection.cursor()
        cursor.execute("SET LOCAL max_parallel_workers_per_gather = 0")
        plans = []
        for statement, parameters in captured:
            cursor.execute("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement, parameters)
            plans.append(cursor.fetchone()[0][0]["Plan"])
        db.rollback()
    return plans


def _identity_scans(
    plan: dict[str, Any], leaves: set[str], inside: bool = False
) -> Iterator[dict[str, Any]]:
    """The audit leaf scans that run inside a subplan, which is where an identity read runs."""

    inside = inside or plan.get("Parent Relationship") in {"SubPlan", "InitPlan"}
    if inside and plan.get("Relation Name") in leaves:
        yield plan
    for child in plan.get("Plans", ()):
        yield from _identity_scans(child, leaves, inside)


@pytest.mark.parametrize("reader", [BOARD_ACTIVITY, SETTINGS_HISTORY])
def test_activity_readers_read_their_identities_once_at_any_month_count(
    activity_history: _ActivityHistory, reader: str
) -> None:
    # REQ-0007: an `IN (subquery)` under `OR` stayed a subplan in each partition's filter, so
    # each populated month ran the identity read again. A probe plan shows as loops for each
    # candidate row, a hashed plan as loops for each month; the pages also guard other folds.
    world = activity_history
    leaves = {partition_name(first_day) for first_day in world.months}
    pages = {}
    for month_count in (FEW_MONTHS, MANY_MONTHS):
        _spread_activity(world, month_count)
        scans = [
            scan
            for plan in _activity_plans(world, reader)
            for scan in _identity_scans(plan, leaves)
        ]
        assert [
            (scan["Relation Name"], scan["Actual Loops"])
            for scan in scans
            if scan["Actual Loops"] > 1
        ] == []
        pages[month_count] = sum(_pages(scan) for scan in scans)

    assert pages[FEW_MONTHS] > 0, pages
    assert pages[MANY_MONTHS] <= pages[FEW_MONTHS] * 5 // 4, pages
