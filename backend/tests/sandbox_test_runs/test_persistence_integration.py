"""PostgreSQL safeguards for temporary Sandbox tests."""

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.systems.access.users.models import User, UserStatus
from app.systems.sandbox.designs.models import SandboxDocument
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge
from app.systems.sandbox.test_runs.models import SandboxTestRun
from app.systems.sandbox.test_runs.schemas import SandboxTestRunCreateRequest
from app.systems.sandbox.test_runs.service import create_run
from tests.sandbox_test_runs.fixtures import sandbox_document

pytestmark = pytest.mark.integration


def test_temporary_test_persists_only_evidence(
    integration_owner_db: Session,
) -> None:
    role = "admin"
    assert role is not None
    actor = User(
        email="sandbox-test-owner@example.test",
        username="sandbox-test-owner",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    integration_owner_db.add(actor)
    integration_owner_db.flush()
    initial = read_document(integration_owner_db)
    saved = replace_document(
        integration_owner_db,
        actor_id=actor.id,
        expected_revision=initial.revision,
        document=sandbox_document(),
    )
    before_records = integration_owner_db.scalar(select(func.count()).select_from(Record))
    before_edges = integration_owner_db.scalar(select(func.count()).select_from(RelationshipEdge))

    result = create_run(
        integration_owner_db,
        actor_id=actor.id,
        payload=SandboxTestRunCreateRequest.model_validate(
            {
                "expectedRevision": saved.revision,
                "moduleId": "requests",
                "values": {"priority": "High", "status": "", "score": 0},
                "event": {"kind": "record-created"},
            }
        ),
    )

    assert result.result.values["status"] == "Triaged"
    assert result.result.values["score"] == 10
    assert integration_owner_db.scalar(select(func.count()).select_from(SandboxTestRun)) == 1
    assert integration_owner_db.scalar(select(func.count()).select_from(Record)) == before_records
    assert (
        integration_owner_db.scalar(select(func.count()).select_from(RelationshipEdge))
        == before_edges
    )


def test_runtime_role_can_manage_saved_test_evidence(
    integration_db: Session,
) -> None:
    document = integration_db.scalar(
        select(SandboxDocument).where(SandboxDocument.singleton_key.is_(True))
    )
    assert document is not None
    run = SandboxTestRun(
        document_id=document.id,
        document_revision=document.revision,
        document_hash=document.content_hash,
        module_id="runtime-check",
        input_values={},
        event={"kind": "record-created"},
        trigger_ids=None,
        result={"values": {}, "routes": [], "triggerTraces": [], "issues": []},
        result_byte_count=0,
    )
    integration_db.add(run)
    integration_db.flush()

    assert integration_db.get(SandboxTestRun, run.id) is run
    run.is_deleted = True
    integration_db.flush()
