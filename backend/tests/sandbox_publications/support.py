"""Shared fixtures and assertions for publication integration tests."""

from hashlib import sha256

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.users.models import Role, User, UserStatus
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.executor import apply_publication, request_fingerprint
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.publications.rules import _field_key
from tests.sandbox_designs.fixtures import sample_document


def actor(db: Session) -> User:
    role = db.scalar(select(Role).where(Role.role == "admin"))
    assert role is not None
    value = User(
        email="publication-owner@example.test",
        username="publication-owner",
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
    )
    db.add(value)
    db.flush()
    return value


def publishable_document() -> SandboxDocument:
    document = sample_document().model_copy(deep=True)
    document.automations = []
    document.scenarios = []
    return document


def publish_structure(
    db: Session, configured: SandboxDocument | None = None
) -> tuple[User, SandboxDocument]:
    publisher = actor(db)
    initial = read_document(db)
    document = configured or publishable_document()
    saved = replace_document(
        db,
        actor_id=publisher.id,
        expected_revision=initial.revision,
        document=document,
    )
    preview = publication_plan(db, saved.document)
    token_digest = sha256(f"preview-{publisher.id}".encode()).hexdigest()
    apply_publication(
        db,
        actor_id=publisher.id,
        expected_revision=saved.revision,
        impact_digest=preview.impact_digest,
        expected_live_state_digest=preview.live_state_digest,
        preview_token_digest=token_digest,
        idempotency_key=f"publication-{publisher.id}",
        fingerprint=request_fingerprint(
            expected_revision=saved.revision,
            document_hash=saved.content_hash,
            impact_digest=preview.impact_digest,
            preview_token_digest=token_digest,
            note=None,
        ),
        note=None,
    )
    return publisher, document


def publish_revision(db: Session, publisher: User, document: SandboxDocument, suffix: str) -> None:
    current = read_document(db)
    saved = replace_document(
        db,
        actor_id=publisher.id,
        expected_revision=current.revision,
        document=document,
    )
    preview = publication_plan(db, saved.document)
    assert not preview.blockers
    token_digest = sha256(f"preview-{suffix}-{publisher.id}".encode()).hexdigest()
    apply_publication(
        db,
        actor_id=publisher.id,
        expected_revision=saved.revision,
        impact_digest=preview.impact_digest,
        expected_live_state_digest=preview.live_state_digest,
        preview_token_digest=token_digest,
        idempotency_key=f"publication-{suffix}-{publisher.id}",
        fingerprint=request_fingerprint(
            expected_revision=saved.revision,
            document_hash=saved.content_hash,
            impact_digest=preview.impact_digest,
            preview_token_digest=token_digest,
            note=None,
        ),
        note=None,
    )


def binding(db: Session, kind: str, sandbox_id: str) -> SandboxBinding:
    value = db.scalar(
        select(SandboxBinding).where(
            SandboxBinding.kind == kind,
            SandboxBinding.sandbox_id == sandbox_id,
        )
    )
    if value is None and kind == "field" and ":" in sandbox_id:
        module_id, field_id = sandbox_id.split(":", 1)
        value = db.scalar(
            select(SandboxBinding).where(
                SandboxBinding.kind == kind,
                SandboxBinding.sandbox_id == _field_key(module_id, field_id),
            )
        )
    assert value is not None
    return value


def bound_department(db: Session, sandbox_id: str) -> Department:
    value = db.get(Department, binding(db, "department", sandbox_id).department_id)
    assert value is not None
    return value


def bound_module(db: Session, sandbox_id: str) -> Module:
    value = db.get(Module, binding(db, "module", sandbox_id).module_id)
    assert value is not None
    return value


def bound_field(db: Session, kind: str, sandbox_id: str) -> Field:
    value = db.get(Field, binding(db, kind, sandbox_id).field_id)
    assert value is not None
    return value
