"""Publication preview and drift integration guarantees."""
# ruff: noqa: E501

from hashlib import sha256

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.schemas import DesignField
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.executor import (
    PublicationError,
    apply_publication,
    request_fingerprint,
)
from app.systems.sandbox.publications.models import SandboxPublication
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge
from tests.sandbox_publications.support import (
    binding,
    bound_department,
    bound_field,
    bound_module,
    publish_revision,
    publish_structure,
    publishable_document,
)

pytestmark = pytest.mark.integration


def test_close_plan_blocks_unbound_children_records_and_live_relationships(
    integration_owner_db: Session,
) -> None:
    publisher, document = publish_structure(integration_owner_db)
    department = bound_department(integration_owner_db, "sample-operations")
    requests = bound_module(integration_owner_db, "sample-requests")
    relationship = bound_field(integration_owner_db, "relationship", "sample-uses")
    integration_owner_db.add(
        Module(
            department_id=department.id,
            module_name="Unmanaged module",
            is_schema_accepted=False,
        )
    )
    integration_owner_db.flush()
    closing = document.model_copy(deep=True)
    next(item for item in closing.design.departments if item.id == "sample-operations").closed = True
    for module in closing.design.modules:
        if module.department_id == "sample-operations":
            module.closed = True
            for field in module.fields:
                field.closed = True
    closing.design.relationships = []
    assert ("close_has_live_dependencies", "sample-operations") in {
        (item.code, item.target_id) for item in publication_plan(integration_owner_db, closing).blockers
    }
    unmanaged = integration_owner_db.scalar(select(Module).where(Module.module_name == "Unmanaged module"))
    assert unmanaged is not None
    unmanaged.is_deleted = True
    source = Record(module_id=requests.id, data={})
    target = Record(module_id=bound_module(integration_owner_db, "sample-equipment").id, data={})
    integration_owner_db.add_all([source, target])
    integration_owner_db.flush()
    integration_owner_db.add(
        RelationshipEdge(field_id=relationship.id, source_record_id=source.id, target_record_id=target.id)
    )
    integration_owner_db.flush()
    targets = {
        item.target_id
        for item in publication_plan(integration_owner_db, closing).blockers
        if item.code == "close_has_live_dependencies"
    }
    assert {"sample-requests", "sample-uses"}.issubset(targets)
    assert publisher.id is not None


def test_preview_reports_non_label_structure_and_automation_changes(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    publisher, published = publish_structure(integration_owner_db, document)
    field_edit = published.model_copy(deep=True)
    field_edit.design.modules[0].fields[1].config.default_value = "Updated"
    _assert_update(
        publication_plan(integration_owner_db, field_edit),
        "field",
        _field_key("sample-requests", "sample-field-requests-title"),
    )
    module_move = published.model_copy(deep=True)
    next(module for module in module_move.design.modules if module.id == "sample-customers").department_id = "sample-operations"
    _assert_update(publication_plan(integration_owner_db, module_move), "module", "sample-customers")
    relationship_edit = published.model_copy(deep=True)
    relationship_edit.design.relationships[0].cardinality = "many-to-many"
    _assert_update(publication_plan(integration_owner_db, relationship_edit), "relationship", "sample-uses")
    assert publisher.id is not None


def test_preview_blocks_schema_and_live_data_incompatible_changes(
    integration_owner_db: Session,
) -> None:
    publisher, document = publish_structure(integration_owner_db)
    requests = bound_module(integration_owner_db, "sample-requests")
    request_number = bound_field(integration_owner_db, "field", "sample-requests:sample-field-requests-request-number")
    title = bound_field(integration_owner_db, "field", "sample-requests:sample-field-requests-title")
    integration_owner_db.add(Record(module_id=requests.id, data={str(request_number.id): "REQ-1", str(title.id): "long existing title"}))
    integration_owner_db.flush()
    narrowed = document.model_copy(deep=True)
    next(field for module in narrowed.design.modules if module.id == "sample-requests" for field in module.fields if field.id == "sample-field-requests-title").config.max_length = 3
    next(module for module in narrowed.design.modules if module.id == "sample-customers").fields = []
    blockers = {(item.code, item.target_id) for item in publication_plan(integration_owner_db, narrowed).blockers}
    assert (
        "field_change_invalidates_records",
        _field_key("sample-requests", "sample-field-requests-title"),
    ) in blockers
    assert ("module_schema_invalid", "sample-customers") in blockers
    assert publisher.id is not None


def test_preview_blocks_a_required_field_added_to_a_module_with_live_records(
    integration_owner_db: Session,
) -> None:
    publisher, document = publish_structure(integration_owner_db)
    module = bound_module(integration_owner_db, "sample-requests")
    request_number = bound_field(
        integration_owner_db,
        "field",
        "sample-requests:sample-field-requests-request-number",
    )
    integration_owner_db.add(Record(module_id=module.id, data={str(request_number.id): "REQ-1"}))
    integration_owner_db.flush()
    changed = document.model_copy(deep=True)
    added = DesignField.model_validate(
        {
            "id": "required-new-field",
            "name": "Required new field",
            "type": "Text",
            "required": True,
            "config": {"kind": "text", "defaultValue": ""},
        }
    )
    next(module for module in changed.design.modules if module.id == "sample-requests").fields.append(added)

    blockers = {(item.code, item.target_id) for item in publication_plan(integration_owner_db, changed).blockers}

    assert ("field_change_invalidates_records", _field_key("sample-requests", added.id)) in blockers
    assert publisher.id is not None


def test_inactive_new_required_fields_do_not_block_existing_records(
    integration_owner_db: Session,
) -> None:
    _publisher, document = publish_structure(integration_owner_db)
    module = bound_module(integration_owner_db, "sample-requests")
    request_number = bound_field(
        integration_owner_db,
        "field",
        "sample-requests:sample-field-requests-request-number",
    )
    integration_owner_db.add(
        Record(module_id=module.id, data={str(request_number.id): "REQ-1"})
    )
    integration_owner_db.flush()
    added = DesignField.model_validate(
        {
            "id": "inactive-required-field",
            "name": "Inactive required field",
            "type": "Text",
            "required": True,
            "config": {"kind": "text", "defaultValue": ""},
        }
    )

    closed_field = document.model_copy(deep=True)
    added_closed = added.model_copy(deep=True)
    added_closed.closed = True
    next(
        item for item in closed_field.design.modules if item.id == "sample-requests"
    ).fields.append(added_closed)

    closed_module = document.model_copy(deep=True)
    module_document = next(
        item for item in closed_module.design.modules if item.id == "sample-requests"
    )
    module_document.closed = True
    for field in module_document.fields:
        field.closed = True
    module_document.fields.append(added)

    target = _field_key("sample-requests", added.id)
    for candidate in (closed_field, closed_module):
        assert ("field_change_invalidates_records", target) not in {
            (item.code, item.target_id)
            for item in publication_plan(integration_owner_db, candidate).blockers
        }


def test_legacy_field_binding_rekeys_without_creating_or_closing_a_live_field(
    integration_owner_db: Session,
) -> None:
    publisher, document = publish_structure(integration_owner_db)
    legacy = "sample-requests:sample-field-requests-title"
    row = binding(integration_owner_db, "field", legacy)
    row.sandbox_id = legacy
    integration_owner_db.flush()
    updated = document.model_copy(deep=True)
    updated.design.modules[0].fields[1].config.default_value = "Updated"

    publish_revision(integration_owner_db, publisher, updated, "legacy-field-key")

    assert row.sandbox_id == _field_key("sample-requests", "sample-field-requests-title")
    assert integration_owner_db.scalar(select(func.count()).select_from(Field)) == 13


def test_preview_blocks_duplicate_active_department_and_module_names(
    integration_owner_db: Session,
) -> None:
    _publisher, document = publish_structure(integration_owner_db)
    duplicate_department = document.design.departments[0].model_copy(deep=True)
    duplicate_department.id = "duplicate-operations"
    document.design.departments.append(duplicate_department)
    equipment = next(module for module in document.design.modules if module.id == "sample-equipment")
    equipment.name = "Service requests"

    blockers = {(item.code, item.target_id) for item in publication_plan(integration_owner_db, document).blockers}

    assert ("department_name_conflict", "duplicate-operations") in blockers
    assert ("module_name_conflict", "sample-equipment") in blockers


def test_preview_returns_a_blocker_for_invalid_config_on_a_bound_field(
    integration_owner_db: Session,
) -> None:
    _publisher, document = publish_structure(integration_owner_db)
    select_field = document.design.modules[0].fields[2]
    select_field.config.options = []

    blockers = {(item.code, item.target_id) for item in publication_plan(integration_owner_db, document).blockers}

    assert ("module_schema_invalid", "sample-requests") in blockers


def test_preview_blocks_names_already_used_by_unbound_live_structure(
    integration_owner_db: Session,
) -> None:
    _publisher, document = publish_structure(integration_owner_db)
    operations = bound_department(integration_owner_db, "sample-operations")
    integration_owner_db.add(Department(department_name="External department"))
    integration_owner_db.add(
        Module(
            department_id=operations.id,
            module_name="External module",
            is_schema_accepted=False,
        )
    )
    integration_owner_db.flush()
    next(department for department in document.design.departments if department.id == "sample-commercial").name = "External department"
    next(module for module in document.design.modules if module.id == "sample-equipment").name = "External module"

    blockers = {(item.code, item.target_id) for item in publication_plan(integration_owner_db, document).blockers}

    assert ("department_name_conflict", "sample-commercial") in blockers
    assert ("module_name_conflict", "sample-equipment") in blockers


def test_publication_allows_swapping_bound_department_and_module_names(
    integration_owner_db: Session,
) -> None:
    publisher, document = publish_structure(integration_owner_db)
    operations = next(item for item in document.design.departments if item.id == "sample-operations")
    commercial = next(item for item in document.design.departments if item.id == "sample-commercial")
    operations.name, commercial.name = commercial.name, operations.name
    requests = next(item for item in document.design.modules if item.id == "sample-requests")
    equipment = next(item for item in document.design.modules if item.id == "sample-equipment")
    requests.name, equipment.name = equipment.name, requests.name

    preview = publication_plan(integration_owner_db, document)

    assert not preview.blockers
    publish_revision(integration_owner_db, publisher, document, "swap-bound-names")
    assert bound_department(integration_owner_db, "sample-operations").department_name == "Commercial"
    assert bound_module(integration_owner_db, "sample-requests").module_name == "Equipment"


def test_preview_blocks_relationship_target_and_cardinality_changes_with_live_edges(
    integration_owner_db: Session,
) -> None:
    _publisher, document = publish_structure(integration_owner_db)
    requests = bound_module(integration_owner_db, "sample-requests")
    equipment = bound_module(integration_owner_db, "sample-equipment")
    relationship = bound_field(integration_owner_db, "relationship", "sample-uses")
    request_number = bound_field(integration_owner_db, "field", "sample-requests:sample-field-requests-request-number")
    asset_tag = bound_field(integration_owner_db, "field", "sample-equipment:sample-field-equipment-asset-tag")
    first = Record(module_id=requests.id, data={str(request_number.id): "REQ-1"})
    second = Record(module_id=requests.id, data={str(request_number.id): "REQ-2"})
    target = Record(module_id=equipment.id, data={str(asset_tag.id): "EQ-1"})
    integration_owner_db.add_all([first, second, target])
    integration_owner_db.flush()
    integration_owner_db.add_all([RelationshipEdge(field_id=relationship.id, source_record_id=first.id, target_record_id=target.id), RelationshipEdge(field_id=relationship.id, source_record_id=second.id, target_record_id=target.id)])
    integration_owner_db.flush()
    changed = document.model_copy(deep=True)
    changed.design.relationships[0].target_module_id = "sample-customers"
    changed.design.relationships[0].cardinality = "one-to-one"
    blockers = {(item.code, item.target_id) for item in publication_plan(integration_owner_db, changed).blockers}
    assert ("relationship_target_change_has_live_edges", "sample-uses") in blockers
    assert ("relationship_cardinality_has_live_edges", "sample-uses") in blockers


def test_publish_keeps_active_positions_contiguous_after_closing_an_earlier_field(integration_owner_db: Session) -> None:
    publisher, document = publish_structure(integration_owner_db)
    edited = document.model_copy(deep=True)
    next(module for module in edited.design.modules if module.id == "sample-requests").fields[0].closed = True
    publish_revision(integration_owner_db, publisher, edited, "close-earlier-field")
    module = bound_module(integration_owner_db, "sample-requests")
    fields = list(integration_owner_db.scalars(select(Field).where(Field.module_id == module.id, Field.is_deleted.is_(False)).order_by(Field.position)))
    assert [field.position for field in fields] == list(range(len(fields)))
    assert bound_field(integration_owner_db, "relationship", "sample-uses").position == len(fields) - 1


def test_preview_blocks_active_unmanaged_fields(integration_owner_db: Session) -> None:
    _publisher, document = publish_structure(integration_owner_db)
    module = bound_module(integration_owner_db, "sample-requests")
    integration_owner_db.add(Field(module_id=module.id, name="Outside Sandbox", type="text", position=99, required=False, config={}))
    integration_owner_db.flush()
    assert ("module_has_unmanaged_fields", "sample-requests") in {(item.code, item.target_id) for item in publication_plan(integration_owner_db, document).blockers}


def test_module_moves_must_preserve_relationship_departments(integration_owner_db: Session) -> None:
    publisher, document = publish_structure(integration_owner_db)
    split = document.model_copy(deep=True)
    next(module for module in split.design.modules if module.id == "sample-requests").department_id = "sample-commercial"
    assert ("relationship_department_mismatch", "sample-uses") in {(item.code, item.target_id) for item in publication_plan(integration_owner_db, split).blockers}
    next(module for module in split.design.modules if module.id == "sample-equipment").department_id = "sample-commercial"
    publish_revision(integration_owner_db, publisher, split, "paired-module-move")
    assert bound_module(integration_owner_db, "sample-requests").department_id == bound_module(integration_owner_db, "sample-equipment").department_id


def test_module_move_blocks_unbound_incoming_relationship(integration_owner_db: Session) -> None:
    _publisher, document = publish_structure(integration_owner_db)
    operations = bound_department(integration_owner_db, "sample-operations")
    requests = bound_module(integration_owner_db, "sample-requests")
    outside = Module(department_id=operations.id, module_name="Outside Sandbox", is_schema_accepted=True)
    integration_owner_db.add(outside)
    integration_owner_db.flush()
    integration_owner_db.add(Field(module_id=outside.id, name="Incoming request", type="relationship", position=0, required=False, config={}, relationship_target_module_id=requests.id, relationship_multiple_targets=False, relationship_multiple_sources=True))
    integration_owner_db.flush()
    for module_id in ("sample-requests", "sample-equipment"):
        next(module for module in document.design.modules if module.id == module_id).department_id = "sample-commercial"
    assert "module_move_breaks_live_relationship" in {item.code for item in publication_plan(integration_owner_db, document).blockers}


def test_publish_rejects_workspace_and_audit_drift_after_preview(integration_owner_db: Session) -> None:
    publisher, document = publish_structure(integration_owner_db)
    edited = document.model_copy(deep=True)
    edited.design.modules[0].fields[0].name = "Renamed after review"
    current = read_document(integration_owner_db)
    saved = replace_document(integration_owner_db, actor_id=publisher.id, expected_revision=current.revision, document=edited)
    preview = publication_plan(integration_owner_db, saved.document)
    profile = integration_owner_db.scalar(select(WorkspaceProfile).where(WorkspaceProfile.singleton_key.is_(True)))
    assert profile is not None
    profile.timezone = "Asia/Manila" if profile.timezone != "Asia/Manila" else "UTC"
    integration_owner_db.flush()
    with pytest.raises(PublicationError) as workspace:
        _apply(integration_owner_db, publisher.id, saved, preview, "workspace-drift")
    assert workspace.value.code == "live_state_changed"
    profile.timezone = "UTC"
    field = bound_field(integration_owner_db, "field", "sample-requests:sample-field-requests-request-number")
    field.audit_redacted = not field.audit_redacted
    integration_owner_db.flush()
    with pytest.raises(PublicationError) as audit:
        _apply(integration_owner_db, publisher.id, saved, preview, "audit-drift")
    assert audit.value.code == "live_state_changed"
    assert integration_owner_db.scalar(select(func.count()).select_from(SandboxPublication)) == 1


def _assert_update(plan, kind: str, sandbox_id: str) -> None:
    assert (kind, "update", sandbox_id) in {(item.kind, item.action, item.sandbox_id) for item in plan.changes}


def _apply(db: Session, actor_id, saved, preview, suffix: str) -> None:
    token = sha256(suffix.encode()).hexdigest()
    apply_publication(db, actor_id=actor_id, expected_revision=saved.revision, impact_digest=preview.impact_digest, expected_live_state_digest=preview.live_state_digest, preview_token_digest=token, idempotency_key=suffix, fingerprint=request_fingerprint(expected_revision=saved.revision, document_hash=saved.content_hash, impact_digest=preview.impact_digest, preview_token_digest=token, note=None), note=None)
