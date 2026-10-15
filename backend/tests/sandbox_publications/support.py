"""Shared fixtures and assertions for publication integration tests."""

from hashlib import sha256
from typing import Protocol
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.users.models import User, UserStatus
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.service import read_document, replace_document
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.executor import apply_publication, request_fingerprint
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.planner import publication_plan
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.publications.schemas import PublicationResponse
from tests.sandbox_designs.fixtures import sample_document


class Saved(Protocol):
    """The saved draft a review approved: a document response or a test's own record."""

    @property
    def revision(self) -> int: ...

    @property
    def content_hash(self) -> str: ...


class Reviewed(Protocol):
    """The digests of the publication review (``publication_plan``)."""

    @property
    def impact_digest(self) -> str: ...

    @property
    def live_state_digest(self) -> str: ...


def publish_saved(
    db: Session,
    actor_id: UUID,
    saved: Saved,
    review: Reviewed,
    *,
    token_digest: str,
    idempotency_key: str,
    note: str | None = None,
) -> PublicationResponse:
    """Apply the reviewed draft as the publication route does after its password check."""

    return apply_publication(
        db,
        actor_id=actor_id,
        expected_revision=saved.revision,
        impact_digest=review.impact_digest,
        expected_live_state_digest=review.live_state_digest,
        preview_token_digest=token_digest,
        idempotency_key=idempotency_key,
        fingerprint=request_fingerprint(
            expected_revision=saved.revision,
            document_hash=saved.content_hash,
            impact_digest=review.impact_digest,
            preview_token_digest=token_digest,
            note=note,
        ),
        note=note,
    )


def actor(db: Session) -> User:
    role = "admin"
    assert role is not None
    value = User(
        email="publication-owner@example.test",
        username="publication-owner",
        status=UserStatus.ACTIVE.value,
        role=role,
    )
    db.add(value)
    db.flush()
    return value


def publishable_document() -> SandboxDocument:
    document = sample_document().model_copy(deep=True)
    document.triggers = []
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
    publish_saved(
        db,
        publisher.id,
        saved,
        preview,
        token_digest=sha256(f"preview-{publisher.id}".encode()).hexdigest(),
        idempotency_key=f"publication-{publisher.id}",
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
    publish_saved(
        db,
        publisher.id,
        saved,
        preview,
        token_digest=sha256(f"preview-{suffix}-{publisher.id}".encode()).hexdigest(),
        idempotency_key=f"publication-{suffix}-{publisher.id}",
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
