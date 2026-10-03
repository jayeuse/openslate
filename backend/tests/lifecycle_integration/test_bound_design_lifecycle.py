"""Bound lifecycle effects survive draft synchronization and ordinary publication."""

from unittest.mock import patch
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

import app.systems.sandbox.lifecycle.execution as lifecycle_execution
from app.systems.sandbox.designs.models import SandboxVersion
from app.systems.sandbox.designs.schemas import FieldMapping, ScenarioDocument
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.exceptions import (
    LifecyclePlanDriftError,
    LifecyclePreflightError,
)
from app.systems.sandbox.lifecycle.planner import plan_lifecycle
from app.systems.sandbox.lifecycle.service import close_lifecycle, purge_lifecycle, reopen_lifecycle
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.records.models import Record
from tests.rbac.support import _client
from tests.sandbox_publications.support import (
    bound_department,
    bound_field,
    bound_module,
    publish_revision,
    publish_structure,
    publishable_document,
)

pytestmark = pytest.mark.integration


@pytest.mark.parametrize("kind", ["department", "module"])
def test_bound_ancestor_closure_survives_supported_publication(
    integration_owner_db: Session, kind: str
) -> None:
    db = integration_owner_db
    configured = publishable_document()
    equipment = next(item for item in configured.design.modules if item.id == "sample-equipment")
    next(
        item for item in equipment.fields if item.id == "sample-field-equipment-location"
    ).closed = True
    if kind == "department":
        next(
            item for item in configured.design.modules if item.id == "sample-requests"
        ).closed = True
    publisher, _ = publish_structure(db, configured)
    root = (
        bound_department(db, "sample-operations")
        if kind == "department"
        else bound_module(db, "sample-equipment")
    )
    independent_field = bound_field(db, "field", "sample-equipment:sample-field-equipment-location")
    independent_module = bound_module(db, "sample-requests")
    before = read_document(db)
    snapshots = list(db.scalars(select(SandboxVersion.snapshot).order_by(SandboxVersion.id)))
    primitive_flags = {
        (module.id, field.id): field.closed
        for module in before.document.design.modules
        for field in module.fields
    }

    close_lifecycle(db, kind, root.id, publisher.id)

    closed = read_document(db)
    assert closed.revision == before.revision + 1
    assert (
        list(db.scalars(select(SandboxVersion.snapshot).order_by(SandboxVersion.id))) == snapshots
    )
    assert {
        (module.id, field.id): field.closed
        for module in closed.document.design.modules
        for field in module.fields
    } == primitive_flags
    assert root.is_deleted
    marker = getattr(root, "lifecycle_close_operation_id", None)
    assert isinstance(marker, UUID)
    assert publication_plan(db, closed.document).blockers == ()
    publish_revision(db, publisher, closed.document, f"after-lifecycle-close-{kind}")
    db.refresh(root)
    assert root.is_deleted and root.lifecycle_close_operation_id == marker
    assert independent_field.is_deleted

    reopen_lifecycle(db, kind, root.id, publisher.id)

    reopened = read_document(db)
    assert not root.is_deleted and root.lifecycle_close_operation_id is None
    assert independent_field.is_deleted
    if kind == "department":
        assert independent_module.is_deleted
    assert {
        (module.id, field.id): field.closed
        for module in reopened.document.design.modules
        for field in module.fields
    } == primitive_flags
    assert publication_plan(db, reopened.document).blockers == ()
    publish_revision(db, publisher, reopened.document, f"after-lifecycle-reopen-{kind}")
    db.refresh(root)
    db.refresh(independent_field)
    assert not root.is_deleted and independent_field.is_deleted


def test_ancestor_lifecycle_preserves_nonempty_draft_mappings_and_existing_blocker(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    publisher, _ = publish_structure(db)
    before = read_document(db)
    draft = before.document.model_copy(deep=True)
    draft.design.relationships[0].field_mappings = [
        FieldMapping(
            source_field_id="sample-field-requests-title",
            target_field_id="sample-field-equipment-name",
        )
    ]
    draft.design.layout["sample-requests"].x += 10
    saved = replace_document(
        db, actor_id=publisher.id, expected_revision=before.revision, document=draft
    )
    module = bound_module(db, "sample-equipment")
    mappings = saved.document.design.relationships[0].field_mappings
    before_flags = [
        (field.id, field.closed) for item in saved.document.design.modules for field in item.fields
    ]

    close_lifecycle(db, "module", module.id, publisher.id)

    closed = read_document(db)
    assert closed.revision == saved.revision + 1
    assert closed.document.design.relationships[0].field_mappings == mappings
    assert [
        (field.id, field.closed) for item in closed.document.design.modules for field in item.fields
    ] == before_flags
    assert closed.document.design.layout == saved.document.design.layout
    codes = {blocker.code for blocker in publication_plan(db, closed.document).blockers}
    assert "relationship_field_mappings_unsupported" in codes
    assert "relationship.mapping_field_closed" not in codes

    reopen_lifecycle(db, "module", module.id, publisher.id)

    reopened = read_document(db)
    assert reopened.document.design.relationships[0].field_mappings == mappings
    assert {blocker.code for blocker in publication_plan(db, reopened.document).blockers} == {
        "relationship_field_mappings_unsupported"
    }


def test_direct_primitive_close_only_prunes_its_mapping_references(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    publisher, _ = publish_structure(db)
    before = read_document(db)
    draft = before.document.model_copy(deep=True)
    removed = FieldMapping(
        source_field_id="sample-field-requests-title", target_field_id="sample-field-equipment-name"
    )
    retained = FieldMapping(
        source_field_id="sample-field-requests-priority",
        target_field_id="sample-field-equipment-location",
    )
    draft.design.relationships[0].field_mappings = [removed, retained]
    replace_document(db, actor_id=publisher.id, expected_revision=before.revision, document=draft)
    field = bound_field(db, "field", "sample-requests:sample-field-requests-title")
    assert field.position == 1

    close_lifecycle(db, "field", field.id, publisher.id)

    closed = read_document(db).document
    module = next(item for item in closed.design.modules if item.id == "sample-requests")
    assert next(item for item in module.fields if item.id == "sample-field-requests-title").closed
    assert closed.design.relationships[0].field_mappings == [retained]
    reopen_lifecycle(db, "field", field.id, publisher.id)
    reopened = read_document(db).document
    assert reopened.design.relationships[0].field_mappings == [retained]
    # Supported ordinary publication compacts active positions while this
    # primitive remains closed; reopening must recover its authored order.
    clean = read_document(db)
    for relationship in clean.document.design.relationships:
        relationship.field_mappings = []
    replace_document(
        db, actor_id=publisher.id, expected_revision=clean.revision, document=clean.document
    )
    close_lifecycle(db, "field", field.id, publisher.id)
    publish_revision(db, publisher, read_document(db).document, "after-primitive-close")
    reviewed = plan_lifecycle(db, "field", field.id, "reopen", publisher.id)
    before_reopen = read_document(db)
    field_states = list(
        db.execute(
            select(Field.id, Field.position, Field.is_deleted)
            .where(Field.module_id == field.module_id)
            .order_by(Field.id)
        )
    )
    with (
        patch.object(db, "commit", side_effect=IntegrityError("owned failure", {}, Exception())),
        pytest.raises(LifecyclePreflightError),
    ):
        reopen_lifecycle(db, "field", field.id, publisher.id, plan=reviewed)
    rolled_back = read_document(db)
    assert (rolled_back.revision, rolled_back.content_hash, rolled_back.document) == (
        before_reopen.revision,
        before_reopen.content_hash,
        before_reopen.document,
    )
    assert (
        list(
            db.execute(
                select(Field.id, Field.position, Field.is_deleted)
                .where(Field.module_id == field.module_id)
                .order_by(Field.id)
            )
        )
        == field_states
    )
    reopen_lifecycle(db, "field", field.id, publisher.id)
    assert not field.is_deleted
    publish_revision(db, publisher, read_document(db).document, "after-primitive-reopen")
    db.refresh(field)
    assert not field.is_deleted and field.position == 1


@pytest.mark.parametrize("kind", ["department", "module", "field", "field-closed-owner"])
def test_bound_structural_purge_removes_current_design_and_owned_bindings_before_publish(
    integration_owner_db: Session, kind: str
) -> None:
    db = integration_owner_db
    publisher, _ = publish_structure(db)
    field_target = kind.startswith("field")
    target_type = "field" if field_target else kind
    root = (
        bound_department(db, "sample-commercial")
        if kind == "department"
        else bound_module(db, "sample-customers")
        if kind == "module"
        else bound_field(db, "field", "sample-requests:sample-field-requests-priority")
    )
    independent = bound_field(db, "field", "sample-requests:sample-field-requests-status")
    independent_state = None
    if kind == "field-closed-owner":
        close_lifecycle(db, "field", independent.id, publisher.id)
        independent_state = (
            independent.position,
            independent.lifecycle_close_operation_id,
            independent.updated_at,
        )
        close_lifecycle(db, "module", root.module_id, publisher.id)
    else:
        close_lifecycle(db, target_type, root.id, publisher.id)
    before = read_document(db)
    draft = before.document.model_copy(deep=True)
    scenario = ScenarioDocument(id="purge-keeps-scenario", name="Keep authored scenario")
    draft.scenarios.append(scenario)
    draft.design.layout["sample-requests"].x += 17
    if field_target:
        draft.design.relationships[0].field_mappings = [
            FieldMapping(
                source_field_id="sample-field-requests-priority",
                target_field_id="sample-field-equipment-location",
            )
        ]
    saved = replace_document(
        db, actor_id=publisher.id, expected_revision=before.revision, document=draft
    )
    snapshots = list(db.scalars(select(SandboxVersion.snapshot).order_by(SandboxVersion.id)))
    target_ids = {root.id}
    if not field_target:
        target_ids.add(bound_module(db, "sample-customers").id)
        target_ids.update(
            db.scalars(
                select(SandboxBinding.field_id).where(
                    SandboxBinding.kind == "field",
                    SandboxBinding.sandbox_id.like("sample-customers%"),
                )
            )
        )
    plan = plan_lifecycle(db, target_type, root.id, "purge", publisher.id)
    assert not plan.blockers

    purge_lifecycle(db, target_type, root.id, publisher.id, plan=plan)

    after = read_document(db)
    assert after.revision == saved.revision + 1
    assert (
        list(db.scalars(select(SandboxVersion.snapshot).order_by(SandboxVersion.id))) == snapshots
    )
    assert after.document.scenarios == saved.document.scenarios
    assert after.document.triggers == saved.document.triggers
    assert (
        after.document.design.layout["sample-requests"]
        == saved.document.design.layout["sample-requests"]
    )
    assert db.get(type(root), root.id) is None
    if independent_state is not None:
        assert independent.is_deleted
        assert (
            independent.position,
            independent.lifecycle_close_operation_id,
            independent.updated_at,
        ) == independent_state
    assert not list(
        db.scalars(
            select(SandboxBinding).where(
                SandboxBinding.department_id.in_(target_ids)
                | SandboxBinding.module_id.in_(target_ids)
                | SandboxBinding.field_id.in_(target_ids)
            )
        )
    )
    if kind == "department":
        assert "sample-commercial" not in {item.id for item in after.document.design.departments}
    if kind in {"department", "module"}:
        assert "sample-customers" not in {item.id for item in after.document.design.modules}
    else:
        module = next(
            item for item in after.document.design.modules if item.id == "sample-requests"
        )
        assert "sample-field-requests-priority" not in {item.id for item in module.fields}
        assert after.document.design.relationships[0].field_mappings == []
    assert publication_plan(db, after.document).blockers == ()
    if field_target:
        owner = bound_module(db, "sample-requests")
        if not owner.is_deleted:
            close_lifecycle(db, "module", owner.id, publisher.id)
        publish_revision(db, publisher, read_document(db).document, f"closed-after-purge-{kind}")
        reopen_lifecycle(db, "module", owner.id, publisher.id)
        assert not owner.is_deleted
        assert independent.is_deleted is (independent_state is not None)
    publish_revision(db, publisher, read_document(db).document, f"after-structural-purge-{kind}")
    assert db.get(type(root), root.id) is None


@pytest.mark.parametrize("drift", ["document", "binding", "survivor"])
def test_bound_purge_rejects_full_document_or_binding_identity_drift(
    integration_owner_db: Session, drift: str
) -> None:
    db = integration_owner_db
    publisher, _ = publish_structure(db)
    target = "field" if drift == "survivor" else "module"
    root = (
        bound_field(db, "field", "sample-requests:sample-field-requests-priority")
        if target == "field"
        else bound_module(db, "sample-customers")
    )
    close_lifecycle(db, target, root.id, publisher.id)
    plan = plan_lifecycle(db, target, root.id, "purge", publisher.id)
    assert not plan.blockers
    if drift == "document":
        before = read_document(db)
        edited = before.document.model_copy(deep=True)
        edited.design.layout["sample-requests"].x += 1
        replace_document(
            db, actor_id=publisher.id, expected_revision=before.revision, document=edited
        )
    elif drift == "binding":
        binding = db.scalar(select(SandboxBinding).where(SandboxBinding.module_id == root.id))
        assert binding is not None
        old_timestamp = binding.updated_at
        binding.sandbox_id = "changed-after-preview"
        db.flush()
        binding.updated_at = old_timestamp
        db.commit()
    else:
        survivor = bound_field(db, "field", "sample-requests:sample-field-requests-title")
        old_timestamp = survivor.updated_at
        survivor.name = "Changed after preview"
        db.flush()
        survivor.updated_at = old_timestamp
        db.commit()
    with pytest.raises(LifecyclePlanDriftError):
        purge_lifecycle(db, target, root.id, publisher.id, plan=plan)
    assert db.get(type(root), root.id) is not None


@pytest.mark.parametrize("target", ["module", "field"])
def test_bound_purge_late_failure_rolls_back_document_bindings_and_live_data(
    integration_owner_db: Session,
    target: str,
) -> None:
    db = integration_owner_db
    publisher, _ = publish_structure(db)
    root = (
        bound_field(db, "field", "sample-requests:sample-field-requests-priority")
        if target == "field"
        else bound_module(db, "sample-customers")
    )
    close_lifecycle(db, target, root.id, publisher.id)
    before = read_document(db)
    binding_ids = set(db.scalars(select(SandboxBinding.id)))
    field_states = list(
        db.execute(
            select(Field.id, Field.position, Field.is_deleted, Field.updated_at).order_by(Field.id)
        )
    )
    plan = plan_lifecycle(db, target, root.id, "purge", publisher.id)
    assert not plan.blockers
    original = lifecycle_execution._purge_instances

    def fail_after_live_removal(request_db: Session, current_plan: object) -> None:
        original(request_db, current_plan)  # type: ignore[arg-type]
        raise IntegrityError("owned test failure", {}, RuntimeError("owned rollback"))

    with patch.object(lifecycle_execution, "_purge_instances", side_effect=fail_after_live_removal):
        with pytest.raises(LifecyclePreflightError):
            purge_lifecycle(db, target, root.id, publisher.id, plan=plan)
    after = read_document(db)
    assert (after.revision, after.content_hash, after.document) == (
        before.revision,
        before.content_hash,
        before.document,
    )
    assert set(db.scalars(select(SandboxBinding.id))) == binding_ids
    assert db.get(type(root), root.id) is not None
    assert (
        list(
            db.execute(
                select(Field.id, Field.position, Field.is_deleted, Field.updated_at).order_by(
                    Field.id
                )
            )
        )
        == field_states
    )


def test_record_restore_clears_old_cascade_before_ordinary_delete_and_next_close(
    integration_owner_db: Session,
) -> None:
    from app.main import create_app

    db = integration_owner_db
    publisher, _ = publish_structure(db)
    module = bound_module(db, "sample-customers")
    required = bound_field(db, "field", "sample-customers:sample-field-customers-customer-id")
    with _client(create_app(), publisher, db) as client:
        created = client.post(
            "/api/records",
            json={"module_id": str(module.id), "data": {str(required.id): "D-record-provenance"}},
        )
        assert created.status_code == 201
        record_id = UUID(created.json()["id"])
        close_lifecycle(db, "module", module.id, publisher.id)
        record = db.get(Record, record_id)
        assert record is not None and record.is_deleted
        marker = getattr(record, "lifecycle_close_operation_id", None)
        assert isinstance(marker, UUID)
        # Publication opens structure only, retaining the deleted record and old marker.
        draft = read_document(db).document.model_copy(deep=True)
        next(item for item in draft.design.modules if item.id == "sample-customers").closed = False
        publish_revision(db, publisher, draft, "different-writer-opens-parent")
        db.refresh(record)
        assert record.is_deleted and record.lifecycle_close_operation_id == marker
        restored = client.post(f"/api/records/{record_id}/restore")
        assert restored.status_code == 200
        db.refresh(record)
        assert not record.is_deleted and record.lifecycle_close_operation_id is None
        assert client.delete(f"/api/records/{record_id}").status_code == 204
        close_lifecycle(db, "module", module.id, publisher.id)
        reopen_lifecycle(db, "module", module.id, publisher.id)
        db.refresh(record)
        assert record.is_deleted and record.lifecycle_close_operation_id is None


def test_field_purge_keeps_duplicate_closed_positions_invalid(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    publisher, _ = publish_structure(db)
    owner = bound_module(db, "sample-requests")
    root = bound_field(db, "field", "sample-requests:sample-field-requests-priority")
    close_lifecycle(db, "module", owner.id, publisher.id)
    survivors = list(
        db.scalars(
            select(Field).where(Field.module_id == owner.id, Field.id != root.id).order_by(Field.id)
        )
    )
    survivors[1].position = survivors[0].position
    db.commit()
    positions = [(item.id, item.position, item.lifecycle_close_operation_id) for item in survivors]
    purge_lifecycle(db, "field", root.id, publisher.id)
    assert [
        (item.id, item.position, item.lifecycle_close_operation_id) for item in survivors
    ] == positions
    with pytest.raises(LifecyclePreflightError):
        reopen_lifecycle(db, "module", owner.id, publisher.id)
