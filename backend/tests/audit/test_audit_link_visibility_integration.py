"""Audit entries of a link follow the link's own visibility: both modules readable."""

from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import UserRole
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
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
