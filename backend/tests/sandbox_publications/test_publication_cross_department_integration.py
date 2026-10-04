"""Publication guarantees for relationships between modules in two departments."""

import pytest
from sqlalchemy.orm import Session

from app.systems.sandbox.designs.schemas import RelationshipDocument, SandboxDocument
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge
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
