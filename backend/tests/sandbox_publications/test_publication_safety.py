"""Publication preview and blocked-write integration guarantees."""

from hashlib import sha256

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.systems.sandbox.automations.models import PublishedAutomationDefinition
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.schemas import AutomationDocument
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
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge
from tests.sandbox_publications.support import actor, publishable_document

pytestmark = pytest.mark.integration


def test_preview_is_read_only_and_publish_creates_only_bound_structure(
    integration_owner_db: Session,
) -> None:
    publisher = actor(integration_owner_db)
    initial = read_document(integration_owner_db)
    saved = replace_document(
        integration_owner_db,
        actor_id=publisher.id,
        expected_revision=initial.revision,
        document=publishable_document(),
    )

    before_preview = _live_structure_counts(integration_owner_db)
    preview = publication_plan(integration_owner_db, saved.document)

    assert not preview.blockers
    assert _live_structure_counts(integration_owner_db) == before_preview

    token_digest = sha256(b"preview").hexdigest()
    response = apply_publication(
        integration_owner_db,
        actor_id=publisher.id,
        expected_revision=saved.revision,
        impact_digest=preview.impact_digest,
        expected_live_state_digest=preview.live_state_digest,
        preview_token_digest=token_digest,
        idempotency_key="publication-integration-1",
        fingerprint=request_fingerprint(
            expected_revision=saved.revision,
            document_hash=saved.content_hash,
            impact_digest=preview.impact_digest,
            preview_token_digest=token_digest,
            note=None,
        ),
        note=None,
    )

    assert response.version.kind == "published"
    additions = {
        "departments": 2,
        "modules": 3,
        "fields": 13,
        "bindings": 18,
        "publications": 1,
        "automation_definitions": 0,
        "records": 0,
        "relationships": 0,
    }
    assert _live_structure_counts(integration_owner_db) == {
        name: count + additions[name] for name, count in before_preview.items()
    }


def test_relationship_scoped_automation_blocks_publish_without_live_writes(
    integration_owner_db: Session,
) -> None:
    before = _live_structure_counts(integration_owner_db)
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

    assert _live_structure_counts(integration_owner_db) == before


def _live_structure_counts(db: Session) -> dict[str, int]:
    return {
        "departments": int(db.scalar(select(func.count()).select_from(Department)) or 0),
        "modules": int(db.scalar(select(func.count()).select_from(Module)) or 0),
        "fields": int(db.scalar(select(func.count()).select_from(Field)) or 0),
        "bindings": int(db.scalar(select(func.count()).select_from(SandboxBinding)) or 0),
        "publications": int(db.scalar(select(func.count()).select_from(SandboxPublication)) or 0),
        "automation_definitions": int(
            db.scalar(select(func.count()).select_from(PublishedAutomationDefinition)) or 0
        ),
        "records": int(db.scalar(select(func.count()).select_from(Record)) or 0),
        "relationships": int(db.scalar(select(func.count()).select_from(RelationshipEdge)) or 0),
    }
