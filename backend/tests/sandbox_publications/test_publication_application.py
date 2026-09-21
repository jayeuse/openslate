"""Publication application integration guarantees."""

from hashlib import sha256

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.systems.sandbox.automations.models import (
    PublishedAutomationAction,
    PublishedAutomationCondition,
    PublishedAutomationDefinition,
)
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.schemas import AutomationDocument, SandboxDocument
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.executor import (
    PublicationError,
    apply_publication,
    request_fingerprint,
)
from app.systems.sandbox.publications.models import SandboxBinding, SandboxPublication
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.router import create_record
from app.systems.sandbox.records.schemas import RecordCreate
from app.systems.sandbox.relationships.models import RelationshipEdge
from tests.sandbox_publications.support import (
    actor,
    binding,
    bound_field,
    bound_module,
    publish_revision,
    publish_structure,
    publishable_document,
)

pytestmark = pytest.mark.integration


def test_preview_is_read_only_and_publish_creates_only_bound_structure(
    integration_owner_db: Session,
) -> None:
    publisher = actor(integration_owner_db)
    initial = read_document(integration_owner_db)
    document = publishable_document()
    saved = replace_document(
        integration_owner_db,
        actor_id=publisher.id,
        expected_revision=initial.revision,
        document=document,
    )

    preview = publication_plan(integration_owner_db, saved.document)

    assert not preview.blockers
    assert integration_owner_db.scalar(select(func.count()).select_from(Department)) == 0
    assert integration_owner_db.scalar(select(func.count()).select_from(Record)) == 0
    assert integration_owner_db.scalar(select(func.count()).select_from(RelationshipEdge)) == 0

    response = apply_publication(
        integration_owner_db,
        actor_id=publisher.id,
        expected_revision=saved.revision,
        impact_digest=preview.impact_digest,
        expected_live_state_digest=preview.live_state_digest,
        preview_token_digest=sha256(b"preview").hexdigest(),
        idempotency_key="publication-integration-1",
        fingerprint=request_fingerprint(
            expected_revision=saved.revision,
            document_hash=saved.content_hash,
            impact_digest=preview.impact_digest,
            preview_token_digest=sha256(b"preview").hexdigest(),
            note=None,
        ),
        note=None,
    )

    assert response.version.kind == "published"
    assert integration_owner_db.scalar(select(func.count()).select_from(Department)) == 2
    assert integration_owner_db.scalar(select(func.count()).select_from(Module)) == 3
    assert integration_owner_db.scalar(select(func.count()).select_from(Field)) == 13
    assert integration_owner_db.scalar(select(func.count()).select_from(SandboxBinding)) == 18
    assert integration_owner_db.scalar(select(func.count()).select_from(SandboxPublication)) == 1
    assert (
        integration_owner_db.scalar(select(func.count()).select_from(PublishedAutomationDefinition))
        == 0
    )
    assert integration_owner_db.scalar(select(func.count()).select_from(Record)) == 0
    assert integration_owner_db.scalar(select(func.count()).select_from(RelationshipEdge)) == 0


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


def test_relationship_scoped_automation_blocks_publish_without_live_writes(
    integration_owner_db: Session,
) -> None:
    publisher = actor(integration_owner_db)
    initial = read_document(integration_owner_db)
    document = publishable_document()
    document.automations = [
        AutomationDocument.model_validate(
            {
                "id": "relationship-reference",
                "name": "Unsupported relationship reference",
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
                            "relationshipId": "sample-uses",
                        },
                        "value": {"kind": "literal", "value": "Open"},
                    }
                ],
            }
        )
    ]
    saved = replace_document(
        integration_owner_db,
        actor_id=publisher.id,
        expected_revision=initial.revision,
        document=document,
    )
    preview = publication_plan(integration_owner_db, saved.document)
    assert "automation_relationship_reference_unsupported" in {
        blocker.code for blocker in preview.blockers
    }
    token_digest = sha256(b"relationship-reference-preview").hexdigest()

    with pytest.raises(PublicationError, match="Fix the listed publication blockers"):
        apply_publication(
            integration_owner_db,
            actor_id=publisher.id,
            expected_revision=saved.revision,
            impact_digest=preview.impact_digest,
            expected_live_state_digest=preview.live_state_digest,
            preview_token_digest=token_digest,
            idempotency_key="relationship-reference",
            fingerprint=request_fingerprint(
                expected_revision=saved.revision,
                document_hash=saved.content_hash,
                impact_digest=preview.impact_digest,
                preview_token_digest=token_digest,
                note=None,
            ),
            note=None,
        )

    assert integration_owner_db.scalar(select(func.count()).select_from(Department)) == 0
    assert integration_owner_db.scalar(select(func.count()).select_from(Record)) == 0
    assert integration_owner_db.scalar(select(func.count()).select_from(RelationshipEdge)) == 0


def test_retired_automation_children_do_not_block_field_closure(
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
    automation = PublishedAutomationDefinition(
        publication_id=publication.id,
        published_version_id=publication.version_id,
        publisher_id=publisher.id,
        module_id=module.id,
        name="Dependency check",
        enabled=True,
        priority=0,
        trigger_kind="field-changed",
        trigger_field_id=field.id,
        workspace_timezone="UTC",
        condition_operator="all",
    )
    integration_owner_db.add(automation)
    integration_owner_db.flush()
    integration_owner_db.add_all(
        [
            PublishedAutomationCondition(
                automation_id=automation.id,
                field_id=field.id,
                position=0,
                operator="=",
                value_kind="literal",
                literal_value={"value": "High"},
            ),
            PublishedAutomationAction(
                automation_id=automation.id,
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
            kind="automation",
            sandbox_id="retired-dependency-check",
            automation_id=automation.id,
            performed_by=publisher.id,
        )
    )
    automation.is_deleted = True
    automation.enabled = False
    integration_owner_db.flush()
    retired_plan = publication_plan(integration_owner_db, closing)
    assert ("close_has_live_dependencies", field_key) not in {
        (item.code, item.target_id) for item in retired_plan.blockers
    }


def test_replacing_sandbox_automations_can_close_their_old_structure(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    document.automations = [_triage_automation()]
    publisher, published = publish_structure(integration_owner_db, document)
    replacement = published.model_copy(deep=True)
    replacement.design.departments = []
    replacement.design.modules = []
    replacement.design.relationships = []
    replacement.design.layout = {}
    replacement.automations = []

    plan = publication_plan(integration_owner_db, replacement)

    assert not plan.blockers
    publish_revision(integration_owner_db, publisher, replacement, "replace-template")
    assert all(
        row.is_deleted
        for row in integration_owner_db.scalars(select(PublishedAutomationDefinition))
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


def test_republishing_an_unchanged_automation_preserves_its_definition(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    document.automations = [_triage_automation()]
    publisher, published = publish_structure(integration_owner_db, document)
    before = binding(integration_owner_db, "automation", "sample-triage").automation_id
    assert before is not None

    publish_revision(integration_owner_db, publisher, published, "unchanged-automation")

    after = binding(integration_owner_db, "automation", "sample-triage").automation_id
    assert after == before
    assert (
        integration_owner_db.scalar(
            select(func.count())
            .select_from(PublishedAutomationDefinition)
            .where(PublishedAutomationDefinition.is_deleted.is_(False))
        )
        == 1
    )


def test_retained_automation_blocks_closing_its_trigger_module(
    integration_owner_db: Session,
) -> None:
    document = publishable_document()
    document.automations = [_triage_automation()]
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


def _triage_automation() -> AutomationDocument:
    return AutomationDocument.model_validate(
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
                    "value": {"kind": "literal", "value": "Open"},
                }
            ],
        }
    )
