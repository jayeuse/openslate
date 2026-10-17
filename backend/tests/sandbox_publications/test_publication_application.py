"""Publication application integration guarantees."""

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.designs.schemas import SandboxDocument, TriggerDocument
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.models import SandboxBinding, SandboxPublication
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.record_triggers.models import (
    RecordTrigger,
    RecordTriggerAction,
    RecordTriggerCondition,
)
from app.systems.sandbox.records.grouping import query_grouped_records
from app.systems.sandbox.records.query import query_records
from app.systems.sandbox.records.query_schemas import GroupedRecordQuery, RecordQuery
from app.systems.sandbox.records.router import create_record
from app.systems.sandbox.records.schemas import RecordCreate
from tests.rbac.support import organization
from tests.sandbox_designs.fixtures import sample_option_id
from tests.sandbox_publications.support import (
    binding,
    bound_field,
    bound_module,
    publish_revision,
    publish_structure,
    publishable_document,
)

pytestmark = pytest.mark.integration


def test_published_select_id_keeps_record_value_when_option_label_changes(
    integration_owner_db: Session,
) -> None:
    payload = publishable_document().model_dump(by_alias=True, mode="json")
    payload["schemaVersion"] = 4
    for module in payload["design"]["modules"]:
        for field in module["fields"]:
            if field["type"] == "Select":
                field["config"]["options"] = [
                    {
                        "id": str(uuid7()),
                        "label": option["label"] if isinstance(option, dict) else option,
                    }
                    for option in field["config"]["options"]
                ]
    request_module = next(
        module for module in payload["design"]["modules"] if module["id"] == "sample-requests"
    )
    request_module["titleFieldId"] = "sample-field-requests-status"
    status = next(field for field in request_module["fields"] if field["type"] == "Select")
    option_id = status["config"]["options"][0]["id"]
    publisher, document = publish_structure(
        integration_owner_db, SandboxDocument.model_validate(payload)
    )
    module = bound_module(integration_owner_db, "sample-requests")
    status_field = bound_field(
        integration_owner_db, "field", "sample-requests:sample-field-requests-status"
    )
    number_field = bound_field(
        integration_owner_db, "field", "sample-requests:sample-field-requests-request-number"
    )
    assert module.title_field_id == status_field.id
    record = create_record(
        RecordCreate(
            module_id=module.id,
            data={str(number_field.id): "REQ-SELECT", str(status_field.id): option_id},
        ),
        publisher,
        integration_owner_db,
    )

    renamed_payload = document.model_dump(by_alias=True, mode="json")
    renamed_module = next(
        item for item in renamed_payload["design"]["modules"] if item["id"] == "sample-requests"
    )
    renamed_status = next(item for item in renamed_module["fields"] if item["type"] == "Select")
    renamed_status["config"]["options"][0]["label"] = "Awaiting review"
    publish_revision(
        integration_owner_db,
        publisher,
        SandboxDocument.model_validate(renamed_payload),
        "rename-select-option",
    )

    reference = {"field_id": status_field.id, "expected_type": "select"}
    query = RecordQuery(
        module_id=module.id,
        definition={
            "columns": [reference],
            "filters": [{**reference, "operator": "eq", "value": option_id}],
        },
    )
    result = query_records(integration_owner_db, query, reader=publisher)
    assert [item.id for item in result.items] == [record.id]
    assert result.items[0].data[str(status_field.id)] == option_id
    assert result.items[0].display_values[str(status_field.id)] == "Awaiting review"
    grouped = query_grouped_records(
        integration_owner_db,
        GroupedRecordQuery(
            module_id=module.id,
            definition={"columns": [reference]},
            group_by=reference,
            selected_group={"kind": "value", "value": option_id},
        ),
        reader=publisher,
    )
    assert [(item.value, item.label, item.count) for item in grouped.groups] == [
        (option_id, "Awaiting review", 1)
    ]
    assert [item.id for item in grouped.items] == [record.id]


def test_initial_relationship_is_closed_when_its_target_module_is_closed(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    target = next(module for module in document.design.modules if module.id == "sample-equipment")
    target.closed = True
    for field in target.fields:
        field.closed = True

    _publisher, _published = publish_structure(integration_owner_db, document)

    relationship = bound_field(integration_owner_db, "relationship", "sample-uses")
    assert relationship.is_deleted
    assert relationship.deleted_at is not None


def test_closing_a_published_relationship_endpoint_is_stable_on_repreview(
    integration_owner_db: Session,
) -> None:
    publisher, published = publish_structure(integration_owner_db)
    closing = published.model_copy(deep=True)
    target = next(module for module in closing.design.modules if module.id == "sample-equipment")
    target.closed = True

    first_plan = publication_plan(integration_owner_db, closing)

    assert not first_plan.blockers
    publish_revision(integration_owner_db, publisher, closing, "close-relationship-endpoint")
    relationship = bound_field(integration_owner_db, "relationship", "sample-uses")
    target_module = bound_module(integration_owner_db, "sample-equipment")
    assert relationship.is_deleted
    assert all(
        field.is_deleted
        for field in integration_owner_db.scalars(
            select(Field).where(Field.module_id == target_module.id)
        )
    )

    unchanged_plan = publication_plan(integration_owner_db, closing)
    assert not unchanged_plan.blockers
    assert unchanged_plan.changes == ()


def test_published_integer_default_creates_a_valid_operational_record(
    integration_owner_db: Session,
) -> None:
    payload = publishable_document().model_dump(by_alias=True, mode="json")
    request_module = payload["design"]["modules"][0]
    priority = request_module["fields"][3]
    priority["type"] = "Integer"
    priority["config"] = {
        "kind": "integer",
        "defaultValue": 4.0,
        "min": 0.0,
        "max": 10.0,
        "step": 2.0,
    }
    publisher, _document = publish_structure(
        integration_owner_db,
        SandboxDocument.model_validate(payload),
    )
    module = bound_module(integration_owner_db, "sample-requests")
    priority_field = bound_field(
        integration_owner_db,
        "field",
        "sample-requests:sample-field-requests-priority",
    )
    request_number = bound_field(
        integration_owner_db,
        "field",
        "sample-requests:sample-field-requests-request-number",
    )

    record = create_record(
        RecordCreate(module_id=module.id, data={str(request_number.id): "REQ-001"}),
        publisher,
        integration_owner_db,
    )

    default = record.data[str(priority_field.id)]
    assert default == 4
    assert type(default) is int


def test_retired_trigger_children_do_not_block_field_closure(
    integration_owner_db: Session,
) -> None:
    publisher, document = publish_structure(integration_owner_db)
    module = bound_module(integration_owner_db, "sample-requests")
    legacy_field_key = "sample-requests:sample-field-requests-priority"
    field_key = _field_key("sample-requests", "sample-field-requests-priority")
    field = bound_field(integration_owner_db, "field", legacy_field_key)
    publication = integration_owner_db.scalar(
        select(SandboxPublication).order_by(SandboxPublication.created_at.desc())
    )
    assert publication is not None
    record_trigger = RecordTrigger(
        org_id=publication.org_id,
        publication_id=publication.id,
        published_version_id=publication.version_id,
        publisher_id=publisher.id,
        module_id=module.id,
        name="Dependency check",
        enabled=True,
        priority=0,
        event_kind="field-changed",
        trigger_field_id=field.id,
        workspace_timezone="UTC",
        condition_operator="all",
    )
    integration_owner_db.add(record_trigger)
    integration_owner_db.flush()
    integration_owner_db.add_all(
        [
            RecordTriggerCondition(
                org_id=record_trigger.org_id,
                trigger_id=record_trigger.id,
                field_id=field.id,
                position=0,
                operator="=",
                value_kind="literal",
                literal_value={"value": "High"},
            ),
            RecordTriggerAction(
                org_id=record_trigger.org_id,
                trigger_id=record_trigger.id,
                target_field_id=field.id,
                position=0,
                kind="set-field",
                value_kind="literal",
                literal_value={"value": "High"},
            ),
        ]
    )
    integration_owner_db.flush()
    closing = document.model_copy(deep=True)
    next(
        item
        for item in next(
            module for module in closing.design.modules if module.id == "sample-requests"
        ).fields
        if item.id == "sample-field-requests-priority"
    ).closed = True

    active_plan = publication_plan(integration_owner_db, closing)
    assert ("close_has_live_dependencies", field_key) in {
        (item.code, item.target_id) for item in active_plan.blockers
    }

    integration_owner_db.add(
        SandboxBinding(
            org_id=record_trigger.org_id,
            kind="trigger",
            sandbox_id="retired-dependency-check",
            trigger_id=record_trigger.id,
            performed_by=publisher.id,
        )
    )
    record_trigger.is_deleted = True
    record_trigger.enabled = False
    integration_owner_db.flush()
    retired_plan = publication_plan(integration_owner_db, closing)
    assert ("close_has_live_dependencies", field_key) not in {
        (item.code, item.target_id) for item in retired_plan.blockers
    }


def test_replacing_sandbox_record_triggers_can_close_their_old_structure(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    document.triggers = [_triage_trigger()]
    publisher, published = publish_structure(integration_owner_db, document)
    replacement = published.model_copy(deep=True)
    replacement.design.departments = []
    replacement.design.modules = []
    replacement.design.relationships = []
    replacement.design.layout = {}
    replacement.triggers = []

    plan = publication_plan(integration_owner_db, replacement)

    assert not plan.blockers
    publish_revision(integration_owner_db, publisher, replacement, "replace-template")
    assert all(
        row.is_deleted
        for row in integration_owner_db.scalars(select(RecordTrigger))
    )
    assert all(row.is_deleted for row in integration_owner_db.scalars(select(Module)))


def test_preview_lists_removed_structure_and_preserves_retired_labels(
    integration_owner_db: Session,
) -> None:
    publisher, document = publish_structure(integration_owner_db)
    original_module = bound_module(integration_owner_db, "sample-customers")
    original_name = original_module.module_name
    updated = document.model_copy(deep=True)
    updated.design.modules = [
        module for module in updated.design.modules if module.id != "sample-customers"
    ]
    updated.design.departments = [
        department
        for department in updated.design.departments
        if department.id != "sample-commercial"
    ]
    updated.design.layout = {
        item_id: box
        for item_id, box in updated.design.layout.items()
        if item_id not in {"sample-commercial", "sample-customers"}
    }

    preview = publication_plan(integration_owner_db, updated)

    assert ("department", "close", "sample-commercial") in {
        (change.kind, change.action, change.sandbox_id) for change in preview.changes
    }
    assert ("module", "close", "sample-customers") in {
        (change.kind, change.action, change.sandbox_id) for change in preview.changes
    }
    publish_revision(integration_owner_db, publisher, updated, "remove-commercial")
    retired = bound_module(integration_owner_db, "sample-customers")
    assert retired.is_deleted is True
    assert retired.module_name == original_name


def test_removing_a_field_frees_its_position_and_restores_its_label_after_closure(
    integration_owner_db: Session,
) -> None:
    publisher, document = publish_structure(integration_owner_db)
    retired = bound_field(
        integration_owner_db,
        "field",
        "sample-requests:sample-field-requests-request-number",
    )
    original_name = retired.name
    updated = document.model_copy(deep=True)
    request_module = next(
        module for module in updated.design.modules if module.id == "sample-requests"
    )
    request_module.fields = request_module.fields[1:]

    publish_revision(integration_owner_db, publisher, updated, "remove-leading-field")

    retired_after = bound_field(
        integration_owner_db,
        "field",
        "sample-requests:sample-field-requests-request-number",
    )
    assert retired_after.is_deleted is True
    assert retired_after.name == original_name
    active = list(
        integration_owner_db.scalars(
            select(Field)
            .where(Field.module_id == bound_module(integration_owner_db, "sample-requests").id)
            .where(Field.is_deleted.is_(False))
            .order_by(Field.position)
        )
    )
    assert [field.position for field in active] == list(range(len(active)))


def test_republishing_an_unchanged_trigger_preserves_its_definition(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    document.triggers = [_triage_trigger()]
    publisher, published = publish_structure(integration_owner_db, document)
    before = binding(integration_owner_db, "trigger", "sample-triage").trigger_id
    assert before is not None

    publish_revision(integration_owner_db, publisher, published, "unchanged-trigger")

    after = binding(integration_owner_db, "trigger", "sample-triage").trigger_id
    assert after == before
    assert (
        integration_owner_db.scalar(
            select(func.count())
            .select_from(RecordTrigger)
            .where(RecordTrigger.is_deleted.is_(False))
        )
        == 1
    )


def test_reused_schedule_adopts_the_current_workspace_timezone(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    document.triggers = [_scheduled_trigger()]
    publisher, published = publish_structure(integration_owner_db, document)
    trigger_id = binding(
        integration_owner_db, "trigger", "sample-scheduled-triage"
    ).trigger_id
    assert trigger_id is not None
    definition = integration_owner_db.get(RecordTrigger, trigger_id)
    profile = integration_owner_db.scalar(
        select(WorkspaceProfile).where(
            WorkspaceProfile.id == organization(integration_owner_db).id
        )
    )
    assert definition is not None
    assert profile is not None
    original_timezone = definition.workspace_timezone
    profile.timezone = "Asia/Manila" if original_timezone != "Asia/Manila" else "UTC"
    integration_owner_db.flush()

    publish_revision(integration_owner_db, publisher, published, "schedule-timezone")

    assert (
        binding(integration_owner_db, "trigger", "sample-scheduled-triage").trigger_id
        == trigger_id
    )
    integration_owner_db.refresh(definition)
    assert definition.workspace_timezone == profile.timezone


def test_retained_trigger_blocks_closing_its_trigger_module(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    document.triggers = [_triage_trigger()]
    _publisher, published = publish_structure(integration_owner_db, document)
    closing = published.model_copy(deep=True)
    module = next(module for module in closing.design.modules if module.id == "sample-requests")
    module.closed = True
    for field in module.fields:
        field.closed = True

    blockers = {
        (item.code, item.target_id)
        for item in publication_plan(integration_owner_db, closing).blockers
    }

    assert ("close_has_live_dependencies", "sample-requests") in blockers


def _triage_trigger() -> TriggerDocument:
    return TriggerDocument.model_validate(
        {
            "id": "sample-triage",
            "name": "Triage requests",
            "enabled": True,
            "priority": 0,
            "trigger": {"kind": "record-created", "moduleId": "sample-requests"},
            "conditionGroup": {"operator": "all", "conditions": []},
            "actions": [
                {
                    "id": "set-status",
                    "kind": "set-field",
                    "target": {
                        "moduleId": "sample-requests",
                        "fieldId": "sample-field-requests-status",
                    },
                    "value": {
                        "kind": "literal",
                        "value": sample_option_id("sample-field-requests-status", "Open"),
                    },
                }
            ],
        }
    )


def _scheduled_trigger() -> TriggerDocument:
    value = _triage_trigger().model_dump(by_alias=True)
    value["id"] = "sample-scheduled-triage"
    value["name"] = "Scheduled triage"
    value["trigger"] = {
        "kind": "schedule",
        "moduleId": "sample-requests",
        "frequency": "daily",
        "time": "09:00",
    }
    return TriggerDocument.model_validate(value)
