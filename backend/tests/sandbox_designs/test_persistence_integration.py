"""Real PostgreSQL checks for Sandbox document locking, snapshots, and audit redaction."""

from uuid import uuid4

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

import app.systems.sandbox.designs.service as design_service
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.sandbox.designs.models import SandboxDocument as SandboxDocumentRow
from app.systems.sandbox.designs.models import SandboxVersion
from app.systems.sandbox.designs.service import (
    SandboxDesignError,
    create_version,
    read_document,
    replace_document,
    restore_version,
)
from tests.rbac.support import organization
from tests.sandbox_designs.fixtures import create_document, sample_document

pytestmark = pytest.mark.integration


def _document_with_module_name(name: str):
    document = sample_document().model_copy(deep=True)
    document.design.modules[0].name = name
    return document


def test_replace_checkpoint_restore_and_stale_revision_are_persistent_and_audited(
    integration_owner_db: Session,
) -> None:
    create_document(integration_owner_db, organization(integration_owner_db))
    initial = read_document(integration_owner_db)
    assert initial.document.design.departments == []
    assert initial.document.design.modules == []
    assert initial.document.design.relationships == []
    assert initial.document.design.layout == {}
    assert initial.document.triggers == []
    assert initial.document.scenarios == []
    assert (
        integration_owner_db.scalar(
            select(func.count()).select_from(SandboxVersion).where(
                SandboxVersion.is_deleted.is_(False)
            )
        )
        == 0
    )
    saved = replace_document(
        integration_owner_db,
        actor_id=None,  # type: ignore[arg-type]  # The nullable system actor is valid for seed maintenance.
        expected_revision=initial.revision,
        document=_document_with_module_name("Saved requests"),
    )
    checkpoint = create_version(
        integration_owner_db,
        actor_id=None,  # type: ignore[arg-type]
        expected_revision=saved.revision,
        kind="checkpoint",
        label="Saved state",
        note=None,
    )
    after_checkpoint = read_document(integration_owner_db)
    changed = replace_document(
        integration_owner_db,
        actor_id=None,  # type: ignore[arg-type]
        expected_revision=after_checkpoint.revision,
        document=_document_with_module_name("Changed requests"),
    )

    restored = restore_version(
        integration_owner_db,
        actor_id=None,  # type: ignore[arg-type]
        version_id=checkpoint.id,
        expected_revision=changed.revision,
    )

    assert restored.document.design.modules[0].name == "Saved requests"
    assert restored.revision == changed.revision + 1
    persisted = integration_owner_db.scalar(select(SandboxDocumentRow))
    assert persisted is not None and persisted.revision == restored.revision
    assert persisted.document["design"]["modules"][0]["name"] == "Saved requests"
    versions = integration_owner_db.scalars(
        select(SandboxVersion).where(SandboxVersion.is_deleted.is_(False))
    ).all()
    assert len(versions) == 2

    with pytest.raises(SandboxDesignError, match="reload before saving"):
        replace_document(
            integration_owner_db,
            actor_id=None,  # type: ignore[arg-type]
            expected_revision=initial.revision,
            document=_document_with_module_name("Stale write"),
        )

    audit = integration_owner_db.scalar(
        select(AuditLog)
        .where(AuditLog.entity_type == "sandbox_documents")
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    )
    assert audit is not None
    assert audit.after is not None and audit.after["document"] == REDACTED
    assert "Saved requests" not in str(audit.before)
    assert "Saved requests" not in str(audit.after)


def test_published_versions_do_not_consume_mutable_history_capacity(
    integration_owner_db: Session,
) -> None:
    create_document(integration_owner_db, organization(integration_owner_db))
    initial = read_document(integration_owner_db)
    row = integration_owner_db.scalar(select(SandboxDocumentRow))
    assert row is not None

    for index in range(50):
        design_service._append_version(
            integration_owner_db,
            row=row,
            document=initial.document,
            kind="published",
            label=f"Published {index + 1}",
            note=None,
            actor_id=uuid4(),
        )
    for index in range(49):
        design_service._append_version(
            integration_owner_db,
            row=row,
            document=initial.document,
            kind="checkpoint",
            label=f"Checkpoint {index + 1}",
            note=None,
            actor_id=uuid4(),
        )
    integration_owner_db.flush()

    published_count = integration_owner_db.scalar(
        select(func.count()).select_from(SandboxVersion).where(
            SandboxVersion.is_deleted.is_(False), SandboxVersion.kind == "published"
        )
    )
    mutable_count = integration_owner_db.scalar(
        select(func.count()).select_from(SandboxVersion).where(
            SandboxVersion.is_deleted.is_(False),
            SandboxVersion.kind.in_(("checkpoint", "imported")),
        )
    )
    assert published_count == 50
    assert mutable_count == 49

    fiftieth = create_version(
        integration_owner_db,
        actor_id=uuid4(),
        expected_revision=initial.revision,
        kind="checkpoint",
        label="Checkpoint 50",
        note=None,
    )
    assert fiftieth.kind == "checkpoint"

    with pytest.raises(SandboxDesignError) as rejected:
        create_version(
            integration_owner_db,
            actor_id=uuid4(),
            expected_revision=initial.revision + 1,
            kind="checkpoint",
            label="Checkpoint 51",
            note=None,
        )
    assert rejected.value.code == "version_limit"
