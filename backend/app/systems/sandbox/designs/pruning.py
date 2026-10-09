"""A single revision-locked, audited transaction frees mutable version capacity."""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.systems.sandbox.designs.models import SandboxVersion
from app.systems.sandbox.designs.schemas import VersionPruneResponse
from app.systems.sandbox.designs.service import (
    SandboxDesignError,
    _active_version_count,
    _advance_revision,
    _locked_document,
)


def prune_versions(db: Session, *, actor_id: UUID, expected_revision: int) -> VersionPruneResponse:
    """Delete oldest mutable snapshots down to 40, preserving published and newest."""
    try:
        document = _locked_document(db, expected_revision)
        surplus = max(0, _active_version_count(db, document.id, mutable_only=True) - 40)
        if not surplus:
            return VersionPruneResponse(deleted_count=0)
        active = (
            SandboxVersion.document_id == document.id,
            SandboxVersion.is_deleted.is_(False),
        )
        newest = db.scalar(
            select(SandboxVersion.id)
            .where(*active)
            .order_by(SandboxVersion.sequence.desc())
            .limit(1)
        )
        versions = db.scalars(
            select(SandboxVersion)
            .where(
                *active,
                SandboxVersion.kind.in_(("checkpoint", "imported")),
                SandboxVersion.id != newest,
            )
            .order_by(SandboxVersion.sequence)
            .limit(surplus)
            .with_for_update()
        ).all()
        finished = datetime.now(UTC)
        for version in versions:
            version.is_deleted = True
            version.deleted_at = finished
            version.performed_by = actor_id
        _advance_revision(document, actor_id)
        db.commit()
        return VersionPruneResponse(deleted_count=len(versions))
    except SQLAlchemyError as error:
        db.rollback()
        raise SandboxDesignError(
            "version_prune_unavailable", "Version history is temporarily unavailable", 503
        ) from error
