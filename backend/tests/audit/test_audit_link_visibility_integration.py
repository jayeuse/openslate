"""Audit entries of a link follow the link's own visibility: both modules readable."""

import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.organization_scope import scope_session
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User, UserRole
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.manage.audit.service import audit_log_statement, readable_audit_entries
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge
from tests.rbac.support import (
    _client,
    add_department,
    add_module,
    add_user,
    make_group_access,
)

pytestmark = pytest.mark.integration


def _linked_departments(db: Session) -> tuple[Department, Department, Record, Record]:
    inventory = add_department(db)
    finance = add_department(db)
    items = add_module(db, inventory)
    accounts = add_module(db, finance)
    item = Record(org_id=items.org_id, module_id=items.id, data={})
    account = Record(org_id=accounts.org_id, module_id=accounts.id, data={})
    db.add_all([item, account])
    db.flush()
    return inventory, finance, item, account


def _link(db: Session, source: Record, target: Record, position: int) -> RelationshipEdge:
    field = Field(
        org_id=source.org_id,
        module_id=source.module_id,
        name=f"Link {position}",
        type=FieldType.RELATIONSHIP,
        position=position,
        relationship_target_module_id=target.module_id,
        relationship_multiple_targets=True,
        relationship_multiple_sources=True,
    )
    db.add(field)
    db.flush()
    edge = RelationshipEdge(
        org_id=field.org_id,
        field_id=field.id, source_record_id=source.id, target_record_id=target.id
    )
    db.add(edge)
    db.flush()
    return edge


def test_department_audit_lists_a_link_only_for_readers_of_both_modules(
    integration_db: Session,
) -> None:
    from app.main import create_app

    api = create_app()
    inventory, finance, item, account = _linked_departments(integration_db)
    shelf = Record(org_id=inventory.org_id,
                   module_id=add_module(integration_db, inventory).id, data={})
    integration_db.add(shelf)
    integration_db.flush()
    local = _link(integration_db, item, shelf, 0)
    cross = _link(integration_db, item, account, 1)
    cross.is_deleted = True
    cross.deleted_at = datetime.now(UTC)
    integration_db.flush()
    manager = add_user(integration_db, role=UserRole.MEMBER)
    make_group_access(integration_db, [manager], inventory, level=AccessLevel.MANAGE)
    reader = add_user(integration_db, role=UserRole.MEMBER)
    make_group_access(integration_db, [reader], inventory, level=AccessLevel.MANAGE)
    make_group_access(integration_db, [reader], finance, level=AccessLevel.READ)
    path = f"/api/audit-logs?department_id={inventory.id}&entity_type=relationship_edges&limit=100"

    def listed(user: object) -> dict[str, tuple[str, str]]:
        response = _client(api, user, integration_db).get(path)
        assert response.status_code == 200
        body = response.json()
        assert body["pagination"]["total"] == len(body["items"])
        if user is manager:
            # Neither the link nor the record it reaches in Finance is named.
            assert str(cross.id) not in response.text and str(account.id) not in response.text
        return {entry["id"]: (entry["entity_id"], entry["action"]) for entry in body["items"]}

    def actions(entries: dict[str, tuple[str, str]]) -> list[tuple[str, str]]:
        return sorted(entries.values())

    expected = sorted([(str(local.id), "create"), (str(cross.id), "create")])
    assert actions(listed(manager)) == [(str(local.id), "create")]
    before_purge = listed(reader)
    assert actions(before_purge) == sorted([*expected, (str(cross.id), "delete")])
    soft_delete = next(key for key, value in before_purge.items() if value[1] == "delete")

    # After a purge the full snapshots still name both records, so readers keep that
    # history; the soft delete's diff names neither record, so it is hidden.
    integration_db.delete(cross)
    integration_db.flush()
    assert actions(listed(manager)) == [(str(local.id), "create")]
    after_purge = listed(reader)
    assert actions(after_purge) == sorted([*expected, (str(cross.id), "delete")])
    assert soft_delete not in after_purge


def test_department_audit_options_skip_links_into_unreadable_departments(
    integration_db: Session,
) -> None:
    from app.main import create_app

    api = create_app()
    inventory, finance, item, account = _linked_departments(integration_db)
    _link(integration_db, item, account, 0)
    manager = add_user(integration_db, role=UserRole.MEMBER)
    make_group_access(integration_db, [manager], inventory, level=AccessLevel.MANAGE)
    reader = add_user(integration_db, role=UserRole.MEMBER)
    make_group_access(integration_db, [reader], inventory, level=AccessLevel.MANAGE)
    make_group_access(integration_db, [reader], finance, level=AccessLevel.READ)
    path = f"/api/audit-logs/options?department_id={inventory.id}"

    hidden = _client(api, manager, integration_db).get(path)
    shown = _client(api, reader, integration_db).get(path)
    assert hidden.status_code == shown.status_code == 200
    assert "relationship_edges" not in hidden.json()["entity_types"]
    assert "records" in hidden.json()["entity_types"]
    assert "relationship_edges" in shown.json()["entity_types"]


@dataclass
class _LinkHistory:
    """One organization's link history, with the names of the seeded audit entries."""

    inventory: Department
    returns: Department
    finance: Department
    accounts: Module
    clerk: User
    courier: User
    names: dict[str, str]


def _names(record: Record, other: Record | UUID) -> dict[str, str]:
    target = other.id if isinstance(other, Record) else other
    return {"source_record_id": str(record.id), "target_record_id": str(target)}


def _link_history(db: Session) -> _LinkHistory:
    inventory, finance, item, account = _linked_departments(db)
    returns = add_department(db)
    shelf = Record(org_id=item.org_id, module_id=add_module(db, inventory).id, data={})
    ledger = Record(org_id=account.org_id, module_id=add_module(db, finance).id, data={})
    db.add_all([shelf, ledger])
    db.flush()
    local = _link(db, item, shelf, 0)
    cross = _link(db, item, account, 1)
    accounts = db.get(Module, account.module_id)
    assert accounts is not None
    clerk, courier = add_user(db), add_user(db)
    diff = {"position": 1}
    entries: list[tuple[str, User, Department, str, UUID, Any, Any]] = [
        ("plain", clerk, inventory, "records", item.id, diff, None),
        ("live_local", clerk, inventory, "relationship_edges", local.id, diff, None),
        ("purged_local", clerk, inventory, "relationship_edges", uuid7(),
         _names(item, shelf), None),
        (
            "after_wins", clerk, inventory, "relationship_edges", uuid7(),
            _names(item, shelf), _names(item, account),
        ),
        ("live_cross", courier, inventory, "relationship_edges", cross.id, diff, None),
        ("purged_cross", courier, inventory, "relationship_edges", uuid7(),
         _names(item, account), None),
        ("purged_before", courier, inventory, "relationship_edges", uuid7(),
         None, _names(item, account)),
        ("into_ledger", courier, inventory, "relationship_edges", uuid7(),
         _names(item, ledger), None),
        ("no_snapshot", courier, inventory, "relationship_edges", uuid7(), diff, None),
        ("gone_record", courier, inventory, "relationship_edges", uuid7(),
         _names(item, uuid7()), None),
        ("returned", courier, returns, "relationship_edges", uuid7(),
         _names(item, account), None),
    ]
    start = datetime(2100, 1, 1, tzinfo=UTC)
    names: dict[str, str] = {}
    for position, (name, actor, department, kind, entity_id, after, before) in enumerate(entries):
        row = AuditLog(
            org_id=department.org_id,
            id=uuid7(),
            created_at=start + timedelta(minutes=position),
            action=AuditAction.UPDATE,
            entity_type=kind,
            entity_id=entity_id,
            department_id=department.id,
            performed_by=actor.id,
            after=after,
            before=before,
        )
        object.__setattr__(row, "_audit_internal", True)
        db.add(row)
        names[str(row.id)] = name
    db.flush()
    return _LinkHistory(inventory, returns, finance, accounts, clerk, courier, names)


def _administrator(db: Session, history: _LinkHistory) -> User:
    return add_user(db, role=UserRole.ADMIN)


def _department_manager(db: Session, history: _LinkHistory) -> User:
    """The shape of ``sales.manager@harbor.test``: manage on the department, nothing else."""

    manager = add_user(db, role=UserRole.MEMBER)
    for department in (history.inventory, history.returns):
        make_group_access(db, [manager], department, level=AccessLevel.MANAGE)
    return manager


def _manager_reading_a_department(db: Session, history: _LinkHistory) -> User:
    manager = _department_manager(db, history)
    make_group_access(db, [manager], history.finance, level=AccessLevel.READ)
    return manager


def _manager_reading_a_module(db: Session, history: _LinkHistory) -> User:
    """The shape of ``academic.manager@school.test``: one module of another department."""

    manager = _department_manager(db, history)
    make_group_access(db, [manager], history.finance, history.accounts, level=AccessLevel.READ)
    return manager


_CLERK = ["after_wins", "purged_local", "live_local", "plain"]


@pytest.mark.parametrize(
    ("reader", "courier_entries"),
    [
        pytest.param(
            _administrator,
            [
                "gone_record", "no_snapshot", "into_ledger",
                "purged_before", "purged_cross", "live_cross",
            ],
            id="administrator-sees-every-entry",
        ),
        pytest.param(_department_manager, [], id="manager-sees-no-link-out-of-the-department"),
        pytest.param(
            _manager_reading_a_department,
            ["into_ledger", "purged_before", "purged_cross", "live_cross"],
            id="manager-reading-the-other-department",
        ),
        pytest.param(
            _manager_reading_a_module,
            ["purged_before", "purged_cross", "live_cross"],
            id="manager-reading-one-module-of-the-other-department",
        ),
    ],
)
def test_every_audit_statement_shows_a_reader_the_same_link_entries(
    integration_db: Session, reader: Any, courier_entries: list[str]
) -> None:
    from app.main import create_app

    history = _link_history(integration_db)
    client = _client(create_app(), reader(integration_db, history), integration_db)

    def entries(department: Department, actor: User) -> list[str]:
        response = client.get("/api/audit-logs", params={
            "department_id": str(department.id), "performed_by": str(actor.id), "limit": 100,
        })
        assert response.status_code == 200
        body = response.json()
        assert body["pagination"]["total"] == len(body["items"])
        return [history.names[entry["id"]] for entry in body["items"]]

    def options(department: Department) -> tuple[set[str], set[str]]:
        response = client.get(
            "/api/audit-logs/options", params={"department_id": str(department.id)}
        )
        assert response.status_code == 200
        body = response.json()
        return set(body["entity_types"]), {actor["performed_by"] for actor in body["actors"]}

    assert entries(history.inventory, history.clerk) == _CLERK
    assert entries(history.inventory, history.courier) == courier_entries
    types, actors = options(history.inventory)
    assert {"records", "relationship_edges"} <= types
    assert str(history.clerk.id) in actors
    assert (str(history.courier.id) in actors) is bool(courier_entries)

    sees_the_link = bool(courier_entries)
    assert entries(history.returns, history.courier) == (["returned"] if sees_the_link else [])
    types, actors = options(history.returns)
    assert ("relationship_edges" in types) is sees_the_link
    assert (str(history.courier.id) in actors) is sees_the_link


def test_a_guest_holding_a_manage_row_cannot_list_department_audit(
    integration_db: Session,
) -> None:
    from app.main import create_app

    department = add_department(integration_db)
    guest = add_user(integration_db, role=UserRole.GUEST)
    make_group_access(integration_db, [guest], department, level=AccessLevel.MANAGE)
    client = _client(create_app(), guest, integration_db)

    for path in ("/api/audit-logs", "/api/audit-logs/options"):
        assert client.get(path, params={"department_id": str(department.id)}).status_code == 403


def _plan_nodes(node: dict[str, Any]) -> Iterator[dict[str, Any]]:
    yield node
    for child in node.get("Plans", []):
        yield from _plan_nodes(child)


def test_snapshot_check_finds_records_by_key_under_row_level_security(
    integration_db: Session,
) -> None:
    """A filter here reads every record the member can read, once for each hidden entry."""

    department = add_department(integration_db)
    module = add_module(integration_db, department)
    manager = add_user(integration_db, role=UserRole.MEMBER)
    make_group_access(integration_db, [manager], department, module, level=AccessLevel.READ)
    scope_session(integration_db, department.org_id)
    statement = audit_log_statement(department_id=department.id).where(
        readable_audit_entries(integration_db, manager)
    )
    sql = statement.compile(
        dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
    )
    connection = integration_db.connection()
    # The table is tiny here; these leave the plan the one choice a large table makes.
    connection.exec_driver_sql("SET LOCAL enable_seqscan = off")
    connection.exec_driver_sql("SET LOCAL enable_bitmapscan = off")

    explained = connection.exec_driver_sql(f"EXPLAIN (FORMAT JSON) {sql}").scalar_one()
    plan = explained if isinstance(explained, list) else json.loads(explained)
    records = [
        node for node in _plan_nodes(plan[0]["Plan"]) if node.get("Relation Name") == "records"
    ]

    assert records
    assert not [node for node in records if "_record_id" in node.get("Filter", "")]
