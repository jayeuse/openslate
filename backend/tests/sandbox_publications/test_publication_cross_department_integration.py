"""Publication guarantees for relationships between modules in two departments."""

from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel, Group, GroupAccess
from app.systems.access.policy.scope import (
    department_reader_ids,
    group_reach,
    level_for,
    module_reader_ids,
)
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.openview.charts.models import Chart
from app.systems.openview.charts.router import router as chart_router
from app.systems.sandbox.designs.schemas import RelationshipDocument, SandboxDocument
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge
from tests.charts.widget_reference_support import client as identity_client
from tests.rbac.support import add_user, make_group_access
from tests.sandbox_publications.support import (
    bound_department,
    bound_field,
    bound_module,
    publish_revision,
    publish_structure,
    publishable_document,
)

pytestmark = pytest.mark.integration

REMOVED_DEPARTMENT_RULES = {
    "relationship_department_mismatch",
    "module_move_breaks_live_relationship",
}


def _module(document: SandboxDocument, module_id: str):
    return next(module for module in document.design.modules if module.id == module_id)


def _with_cross_department_relationship() -> SandboxDocument:
    document = publishable_document()
    document.design.relationships.append(
        RelationshipDocument.model_validate(
            {
                "id": "sample-serves",
                "name": "Serves customer",
                "sourceModuleId": "sample-requests",
                "targetModuleId": "sample-customers",
                "cardinality": "one-to-many",
                "fieldMappings": [],
            }
        )
    )
    return document


def _link(db: Session, relationship_id: str, target_module_id: str) -> RelationshipEdge:
    source = Record(module_id=bound_module(db, "sample-requests").id, data={})
    target = Record(module_id=bound_module(db, target_module_id).id, data={})
    db.add_all([source, target])
    db.flush()
    edge = RelationshipEdge(
        field_id=bound_field(db, "relationship", relationship_id).id,
        source_record_id=source.id,
        target_record_id=target.id,
    )
    db.add(edge)
    db.flush()
    return edge


def _blocker_codes(db: Session, document: SandboxDocument) -> set[str]:
    return {item.code for item in publication_plan(db, document).blockers}


def test_moving_one_connected_module_to_another_department_keeps_its_relationship(
    integration_owner_db: Session,
) -> None:
    publisher, document = publish_structure(integration_owner_db)
    edge = _link(integration_owner_db, "sample-uses", "sample-equipment")
    split = document.model_copy(deep=True)
    _module(split, "sample-requests").department_id = "sample-commercial"
    assert not REMOVED_DEPARTMENT_RULES & _blocker_codes(integration_owner_db, split)

    publish_revision(integration_owner_db, publisher, split, "single-module-move")

    requests = bound_module(integration_owner_db, "sample-requests")
    equipment = bound_module(integration_owner_db, "sample-equipment")
    assert requests.department_id == bound_department(integration_owner_db, "sample-commercial").id
    assert equipment.department_id == bound_department(integration_owner_db, "sample-operations").id
    relationship = bound_field(integration_owner_db, "relationship", "sample-uses")
    assert relationship.is_deleted is False
    assert relationship.module_id == requests.id
    assert relationship.relationship_target_module_id == equipment.id
    integration_owner_db.refresh(edge)
    assert edge.is_deleted is False


def test_module_move_publishes_with_an_unbound_incoming_relationship(
    integration_owner_db: Session,
) -> None:
    publisher, document = publish_structure(integration_owner_db)
    operations = bound_department(integration_owner_db, "sample-operations")
    requests = bound_module(integration_owner_db, "sample-requests")
    outside = Module(department_id=operations.id, module_name="Outside Sandbox")
    integration_owner_db.add(outside)
    integration_owner_db.flush()
    incoming = Field(
        module_id=outside.id,
        name="Incoming request",
        type="relationship",
        position=0,
        required=False,
        config={},
        relationship_target_module_id=requests.id,
        relationship_multiple_targets=False,
        relationship_multiple_sources=True,
    )
    integration_owner_db.add(incoming)
    integration_owner_db.flush()
    moved = document.model_copy(deep=True)
    for module_id in ("sample-requests", "sample-equipment"):
        _module(moved, module_id).department_id = "sample-commercial"
    assert not REMOVED_DEPARTMENT_RULES & _blocker_codes(integration_owner_db, moved)

    publish_revision(integration_owner_db, publisher, moved, "move-with-incoming-link")

    commercial = bound_department(integration_owner_db, "sample-commercial")
    assert bound_module(integration_owner_db, "sample-requests").department_id == commercial.id
    integration_owner_db.refresh(incoming)
    assert incoming.is_deleted is False
    assert incoming.relationship_target_module_id == requests.id
    assert outside.department_id == operations.id


def test_new_cross_department_relationship_publishes_a_field_between_departments(
    integration_owner_db: Session,
) -> None:
    publisher, _document = publish_structure(integration_owner_db)
    connected = _with_cross_department_relationship()

    # publish_revision asserts that the preview has no blockers.
    publish_revision(integration_owner_db, publisher, connected, "cross-department-link")

    relationship = bound_field(integration_owner_db, "relationship", "sample-serves")
    source = integration_owner_db.get(Module, relationship.module_id)
    target = integration_owner_db.get(Module, relationship.relationship_target_module_id)
    assert source is not None and target is not None
    assert relationship.is_deleted is False
    assert relationship.type == "relationship"
    assert source.id == bound_module(integration_owner_db, "sample-requests").id
    assert target.id == bound_module(integration_owner_db, "sample-customers").id
    assert source.department_id == bound_department(integration_owner_db, "sample-operations").id
    assert target.department_id == bound_department(integration_owner_db, "sample-commercial").id


def _close_target(
    document: SandboxDocument,
    module_id: str,
    relationship_id: str,
    department_id: str | None = None,
) -> SandboxDocument:
    closing = document.model_copy(deep=True)
    if department_id is not None:
        next(item for item in closing.design.departments if item.id == department_id).closed = True
    module = _module(closing, module_id)
    module.closed = True
    for field in module.fields:
        field.closed = True
    closing.design.relationships = [
        item for item in closing.design.relationships if item.id != relationship_id
    ]
    return closing


def _close_dependency_targets(db: Session, document: SandboxDocument) -> set[str]:
    return {
        item.target_id
        for item in publication_plan(db, document).blockers
        if item.code == "close_has_live_dependencies" and item.target_id is not None
    }


def test_closing_a_target_department_over_a_live_cross_department_link_blocks_like_one_department(
    integration_owner_db: Session,
) -> None:
    _publisher, document = publish_structure(
        integration_owner_db, _with_cross_department_relationship()
    )
    _link(integration_owner_db, "sample-uses", "sample-equipment")
    _link(integration_owner_db, "sample-serves", "sample-customers")

    same_department = _close_target(document, "sample-equipment", "sample-uses")
    cross_department = _close_target(
        document, "sample-customers", "sample-serves", department_id="sample-commercial"
    )

    assert _close_dependency_targets(integration_owner_db, same_department) == {
        "sample-equipment",
        "sample-uses",
    }
    assert _close_dependency_targets(integration_owner_db, cross_department) == {
        "sample-customers",
        "sample-serves",
    }
    assert "department_close_incomplete" not in _blocker_codes(
        integration_owner_db, cross_department
    )


def test_publication_moves_active_and_archived_charts_once_and_preserves_saved_queries(
    integration_owner_db,
):
    db = integration_owner_db
    publisher, document = publish_structure(db)
    moved_module = bound_module(db, "sample-requests")
    control_module = bound_module(db, "sample-equipment")
    destination = bound_department(db, "sample-commercial").id
    before = {}
    with identity_client(db, publisher, chart_router) as client:
        for name, module in (
            ("Active", moved_module),
            ("Archived", moved_module),
            ("Control", control_module),
        ):
            response = client.post(
                "/api/charts",
                json={
                    "module_id": str(module.id),
                    "name": name,
                    "chart_type": "records",
                    "query": {
                        "module_id": str(module.id),
                        "definition": {"version": 1, "columns": []},
                    },
                },
            )
            assert response.status_code == 201, response.text
            saved = response.json()
            if name == "Archived":
                assert client.delete(f"/api/charts/{saved['id']}?revision=1").status_code == 204
                saved = client.get(f"/api/charts/{saved['id']}").json()
            before[name] = saved
        deleted_dates = {
            saved["id"]: db.get(Chart, UUID(saved["id"])).deleted_at for saved in before.values()
        }
        moving = document.model_copy(deep=True)
        _module(moving, "sample-requests").department_id = "sample-commercial"
        publish_revision(db, publisher, moving, "saved-chart-move")
        after = {}
        for name, saved in before.items():
            response = client.get(f"/api/charts/{saved['id']}")
            assert response.status_code == 200, response.text
            after[name] = response.json()
            assert db.get(Chart, UUID(saved["id"])).deleted_at == deleted_dates[saved["id"]]
            if name == "Control":
                assert after[name] == saved
            else:
                assert after[name]["department_id"] == str(destination)
                assert after[name]["revision"] == saved["revision"] + 1
                for key in (
                    "id",
                    "module_id",
                    "name",
                    "chart_type",
                    "query",
                    "is_deleted",
                ):
                    assert after[name][key] == saved[key]
                logs = list(
                    db.scalars(
                        select(AuditLog).where(
                            AuditLog.entity_type == "charts",
                            AuditLog.entity_id == saved["id"],
                            AuditLog.action == AuditAction.UPDATE,
                        )
                    )
                )
                move_log = next(
                    row for row in logs if row.after.get("department_id") == str(destination)
                )
                assert (
                    move_log.department_id == destination and move_log.performed_by == publisher.id
                )
        stale = client.patch(
            f"/api/charts/{before['Active']['id']}",
            json={"revision": before["Active"]["revision"], "name": "Stale owner"},
        )
        assert stale.status_code == 409 and stale.json()["detail"]["code"] == "stale_revision"
        before_logs = list(
            db.scalars(
                select(AuditLog.id).where(AuditLog.entity_type == "charts").order_by(AuditLog.id)
            )
        )
        publish_revision(db, publisher, moving, "unchanged-chart-owner")
        assert (
            list(
                db.scalars(
                    select(AuditLog.id)
                    .where(AuditLog.entity_type == "charts")
                    .order_by(AuditLog.id)
                )
            )
            == before_logs
        )
        for saved in after.values():
            assert client.get(f"/api/charts/{saved['id']}").json() == saved
        assert db.get(Chart, before["Active"]["id"]).department_id == destination


def _live_rows(db: Session, group_id: UUID) -> set[tuple[UUID, UUID | None, str]]:
    return {
        (row.department_id, row.module_id, row.level)
        for row in db.scalars(
            select(GroupAccess).where(
                GroupAccess.group_id == group_id, GroupAccess.is_deleted.is_(False)
            )
        )
    }


def _access_audit_ids(db: Session) -> list[UUID]:
    return list(
        db.scalars(
            select(AuditLog.id).where(AuditLog.entity_type == "group_access").order_by(AuditLog.id)
        )
    )


def test_publication_moves_module_access_rows_with_their_module(integration_owner_db):
    db = integration_owner_db
    publisher, document = publish_structure(db)
    moved = bound_module(db, "sample-requests")
    unmoved = bound_module(db, "sample-equipment")
    origin = bound_department(db, "sample-operations")
    destination = bound_department(db, "sample-commercial")
    member = add_user(db)
    grant = make_group_access(db, [member], origin, moved, level=AccessLevel.WRITE)
    group = db.get(Group, grant.group_id)
    assert group is not None
    bystander = add_user(db)
    department_grant = make_group_access(db, [bystander], origin, level=AccessLevel.READ)
    make_group_access(
        db,
        [],
        origin,
        unmoved,
        level=AccessLevel.WRITE,
        group=db.get(Group, department_grant.group_id),
    )
    # A row left in the destination by a move before grants followed modules, then
    # the row an administrator wrote later: the later row wins, nothing escalates.
    earlier = make_group_access(db, [], destination, moved, level=AccessLevel.MANAGE)
    make_group_access(
        db,
        [],
        origin,
        moved,
        level=AccessLevel.READ,
        group=db.get(Group, earlier.group_id),
    )
    moving = document.model_copy(deep=True)
    _module(moving, "sample-requests").department_id = "sample-commercial"
    set_audit_actor(db, publisher.id)

    publish_revision(db, publisher, moving, "module-access-move")

    db.expire_all()
    assert _live_rows(db, group.id) == {(destination.id, moved.id, "write")}
    assert _live_rows(db, department_grant.group_id) == {
        (origin.id, None, "read"),
        (origin.id, unmoved.id, "write"),
    }
    assert _live_rows(db, earlier.group_id) == {(destination.id, moved.id, "read")}
    assert level_for(db, member, destination.id, moved.id) == AccessLevel.WRITE
    assert member.id in module_reader_ids(db, moved.id)
    assert member.id in department_reader_ids(db, destination.id)
    assert member.id not in department_reader_ids(db, origin.id)
    assert group_reach(db, group.id) == frozenset({destination.id})
    move_log = db.scalars(
        select(AuditLog).where(
            AuditLog.entity_type == "group_access",
            AuditLog.entity_id == grant.id,
            AuditLog.action == AuditAction.UPDATE,
        )
    ).one()
    assert move_log.after["department_id"] == str(destination.id)
    assert move_log.performed_by == publisher.id
    before_logs = _access_audit_ids(db)

    publish_revision(db, publisher, moving, "unchanged-module-access")

    assert _access_audit_ids(db) == before_logs
