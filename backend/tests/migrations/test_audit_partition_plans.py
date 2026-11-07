"""Plans of the audit list on the partitioned table, as the runtime reads them (K10, K11).

Pages and plan shape only, with parallel workers off (plan rules 9 and 10). The statements
come from the real list service and are replayed in a runtime session.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Connection, event, text
from uuid6 import uuid7

from app.common.listing import StandardListRequest
from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.access.users.models import User, UserRole
from app.systems.manage.audit.models import AuditAction
from app.systems.manage.audit.service import AuditLogSortField, list_audit_logs
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member
from tests.migrations.audit_partition_support import (
    AuditEngines,
    month_starts,
    partition_name,
)
from tests.migrations.audit_partition_support import (
    audit_engines as audit_engines,
)

pytestmark = pytest.mark.integration

ROWS_PER_MONTH = 8_000
SMALL_ROWS_PER_MONTH = 10
# A small organization's list reads 15 pages here; without an index that leads with org_id,
# each statement reads all the pages of the three loaded months, which is about 1,400.
SMALL_ORGANIZATION_PAGE_CEILING = 60
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
    world: _Plans, org_id: UUID, admin_id: UUID, **filters: Any
) -> list[dict[str, Any]]:
    """Run the real list, then read the plan of each of its audit statements as the runtime."""

    captured: list[tuple[str, Any]] = []

    def capture(_connection, _cursor, statement, parameters, _context, _many) -> None:
        if "FROM audit_logs" in statement and not statement.startswith("EXPLAIN"):
            captured.append((statement, parameters))

    runtime = world.engines.runtime
    with AuditSession(bind=runtime) as db:
        scope_session(db, org_id)
        reader = db.get_one(User, admin_id)
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
