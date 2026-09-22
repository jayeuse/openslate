"""Transactions and snapshot invariants for the shared Sandbox design workspace."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from typing import cast
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.systems.sandbox.designs.models import SandboxDocument as SandboxDocumentRow
from app.systems.sandbox.designs.models import SandboxVersion
from app.systems.sandbox.designs.schemas import (
    DocumentResponse,
    PortableBundle,
    PublishedDocumentVersion,
    SandboxDocument,
    VersionDetailResponse,
    VersionListResponse,
    VersionResponse,
)
from app.systems.sandbox.designs.validation import validate_document

MAX_DOCUMENT_BYTES = 5 * 1024 * 1024
IMPORT_ENVELOPE_ALLOWANCE_BYTES = 128
MAX_ACTIVE_VERSIONS = 50


@dataclass(frozen=True, slots=True)
class SandboxDesignError(Exception):
    code: str
    message: str
    status_code: int


def canonical_document(document: SandboxDocument) -> tuple[dict[str, object], str, int]:
    """Return deterministic storage JSON, its SHA-256 digest, and UTF-8 byte length."""

    payload = cast(dict[str, object], document.model_dump(by_alias=True, mode="json"))
    encoded = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode()
    if len(encoded) > MAX_DOCUMENT_BYTES:
        raise SandboxDesignError("document_too_large", "Sandbox document exceeds 5 MiB", 413)
    return payload, sha256(encoded).hexdigest(), len(encoded)


def portable_bundle_bytes(bundle: PortableBundle) -> bytes:
    """Serialize the exact portable JSON form shared by export and import validation."""

    payload = bundle.model_dump(by_alias=True, mode="json")
    if bundle.versions is None:
        payload.pop("versions", None)
    return (
        json.dumps(
            payload,
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode()


def _assert_portable_bundle_size(bundle: PortableBundle) -> None:
    if len(portable_bundle_bytes(bundle)) > MAX_DOCUMENT_BYTES - IMPORT_ENVELOPE_ALLOWANCE_BYTES:
        raise SandboxDesignError("document_too_large", "Sandbox export exceeds 5 MiB", 413)


def read_document(db: Session) -> DocumentResponse:
    row = _document_row(db, lock=False)
    return _document_response(db, row)


def replace_document(
    db: Session, *, actor_id: UUID, expected_revision: int, document: SandboxDocument
) -> DocumentResponse:
    row = _locked_document(db, expected_revision)
    _store_document(row, document, actor_id)
    db.commit()
    db.refresh(row)
    return _document_response(db, row)


def create_version(
    db: Session, *, actor_id: UUID, expected_revision: int, kind: str, label: str, note: str | None
) -> VersionDetailResponse:
    if kind != "checkpoint":
        raise SandboxDesignError(
            "version_kind_not_allowed", "Only checkpoints can be created here", 409
        )
    row = _locked_document(db, expected_revision)
    document = _parse_row_document(row)
    version = _append_version(
        db, row=row, document=document, kind=kind, label=label, note=note, actor_id=actor_id
    )
    _advance_revision(row, actor_id)
    db.commit()
    db.refresh(version)
    return _version_detail(version)


def list_versions(db: Session, *, limit: int, offset: int) -> VersionListResponse:
    statement = (
        select(SandboxVersion)
        .where(SandboxVersion.is_deleted.is_(False))
        .order_by(SandboxVersion.sequence.desc())
    )
    total = int(db.scalar(select(func.count()).select_from(statement.subquery())) or 0)
    items = list(db.scalars(statement.limit(limit).offset(offset)).all())
    return VersionListResponse(
        items=[_version_response(item) for item in items],
        limit=limit,
        offset=offset,
        count=len(items),
        total=total,
        has_more=offset + len(items) < total,
    )


def read_version(db: Session, version_id: UUID) -> VersionDetailResponse:
    return _version_detail(_active_version(db, version_id, lock=False))


def update_version_metadata(
    db: Session,
    *,
    actor_id: UUID,
    version_id: UUID,
    expected_revision: int,
    label: str | None,
    note: str | None,
    update_note: bool,
) -> VersionDetailResponse:
    _locked_document(db, expected_revision)
    version = _active_version(db, version_id, lock=True)
    if version.kind not in {"checkpoint", "imported"}:
        raise SandboxDesignError("version_immutable", "Only checkpoint metadata may be edited", 409)
    if label is not None:
        version.label = label
    if update_note:
        version.note = note
    version.metadata_revision += 1
    version.performed_by = actor_id
    document = _document_row(db, lock=True)
    _advance_revision(document, actor_id)
    db.commit()
    db.refresh(version)
    return _version_detail(version)


def delete_version(
    db: Session, *, actor_id: UUID, version_id: UUID, expected_revision: int
) -> None:
    row = _locked_document(db, expected_revision)
    version = _active_version(db, version_id, lock=True)
    active_count = _active_version_count(db, row.id)
    if active_count <= 1:
        raise SandboxDesignError(
            "version_delete_protected", "The sole version cannot be deleted", 409
        )
    if version.kind == "published":
        raise SandboxDesignError("version_immutable", "Published versions cannot be deleted", 409)
    version.is_deleted = True
    version.deleted_at = datetime.now(UTC)
    version.performed_by = actor_id
    _advance_revision(row, actor_id)
    db.commit()


def restore_version(
    db: Session, *, actor_id: UUID, version_id: UUID, expected_revision: int
) -> DocumentResponse:
    row = _locked_document(db, expected_revision)
    target = _active_version(db, version_id, lock=True)
    if _active_version_count(db, row.id, mutable_only=True) + 1 > MAX_ACTIVE_VERSIONS:
        raise SandboxDesignError("version_limit", "Version history is full", 409)
    before = _parse_row_document(row)
    _append_version(
        db,
        row=row,
        document=before,
        kind="checkpoint",
        label="Before restore",
        note=None,
        actor_id=actor_id,
    )
    restored = _parse_row_document_payload(target.snapshot)
    _store_document(row, restored, actor_id)
    db.commit()
    db.refresh(row)
    return _document_response(db, row)


def import_bundle(
    db: Session, *, actor_id: UUID, expected_revision: int, bundle: PortableBundle
) -> DocumentResponse:
    _assert_portable_bundle_size(bundle)
    row = _locked_document(db, expected_revision)
    imported_document = SandboxDocument.model_validate(
        bundle.model_dump(by_alias=True, exclude={"versions"})
    )
    imported_versions = bundle.versions or []
    if (
        _active_version_count(db, row.id, mutable_only=True) + 1 + len(imported_versions)
        > MAX_ACTIVE_VERSIONS
    ):
        raise SandboxDesignError(
            "version_limit", "Imported history exceeds the 50-version limit", 409
        )
    _append_version(
        db,
        row=row,
        document=_parse_row_document(row),
        kind="checkpoint",
        label="Before import",
        note=None,
        actor_id=actor_id,
    )
    for imported in imported_versions:
        snapshot = SandboxDocument.model_validate(
            {
                "kind": "openslate-sandbox",
                "schemaVersion": 2,
                **imported.document.model_dump(by_alias=True),
            }
        )
        _append_version(
            db,
            row=row,
            document=snapshot,
            kind="imported",
            label=imported.label,
            note=imported.note,
            actor_id=actor_id,
        )
    _store_document(row, imported_document, actor_id)
    db.commit()
    db.refresh(row)
    return _document_response(db, row)


def export_bundle(db: Session, *, include_versions: bool) -> PortableBundle:
    row = _document_row(db, lock=False)
    document = _parse_row_document(row)
    versions = None
    if include_versions:
        versions = [
            {
                "id": str(item.id),
                "label": item.label,
                "kind": item.kind,
                "document": _parse_row_document_payload(item.snapshot).model_dump(
                    by_alias=True, exclude={"kind", "schema_version"}
                ),
                "published": item.kind == "published",
                "date": item.created_at.isoformat(),
                "note": item.note,
            }
            for item in db.scalars(
                select(SandboxVersion)
                .where(SandboxVersion.is_deleted.is_(False))
                .order_by(SandboxVersion.sequence)
            ).all()
        ]
    payload = document.model_dump(by_alias=True)
    if versions is not None:
        payload["versions"] = versions
    bundle = PortableBundle.model_validate(payload)
    _assert_portable_bundle_size(bundle)
    return bundle


def _document_row(db: Session, *, lock: bool) -> SandboxDocumentRow:
    statement = select(SandboxDocumentRow).where(SandboxDocumentRow.singleton_key.is_(True))
    if lock:
        statement = statement.with_for_update()
    row = db.scalar(statement)
    if row is None:
        raise SandboxDesignError("document_unavailable", "Sandbox document is unavailable", 503)
    return row


def _locked_document(db: Session, expected_revision: int) -> SandboxDocumentRow:
    row = _document_row(db, lock=True)
    if row.revision != expected_revision:
        raise SandboxDesignError(
            "stale_revision", "Sandbox document changed; reload before saving", 409
        )
    return row


def _active_version(db: Session, version_id: UUID, *, lock: bool) -> SandboxVersion:
    statement = select(SandboxVersion).where(
        SandboxVersion.id == version_id, SandboxVersion.is_deleted.is_(False)
    )
    if lock:
        statement = statement.with_for_update()
    version = db.scalar(statement)
    if version is None:
        raise SandboxDesignError("version_not_found", "Sandbox version was not found", 404)
    return version


def _active_version_count(
    db: Session,
    document_id: UUID,
    *,
    mutable_only: bool = False,
) -> int:
    criteria = [
        SandboxVersion.document_id == document_id,
        SandboxVersion.is_deleted.is_(False),
    ]
    if mutable_only:
        criteria.append(SandboxVersion.kind.in_(("checkpoint", "imported")))
    return int(
        db.scalar(
            select(func.count()).where(*criteria)
        )
        or 0
    )


def _append_version(
    db: Session,
    *,
    row: SandboxDocumentRow,
    document: SandboxDocument,
    kind: str,
    label: str,
    note: str | None,
    actor_id: UUID,
    source_version_id: UUID | None = None,
) -> SandboxVersion:
    if (
        kind != "published"
        and _active_version_count(db, row.id, mutable_only=True) >= MAX_ACTIVE_VERSIONS
    ):
        raise SandboxDesignError("version_limit", "Version history is full", 409)
    sequence = (
        int(
            db.scalar(
                select(func.max(SandboxVersion.sequence)).where(
                    SandboxVersion.document_id == row.id
                )
            )
            or 0
        )
        + 1
    )
    snapshot, content_hash, byte_count = canonical_document(document)
    version = SandboxVersion(
        document_id=row.id,
        sequence=sequence,
        kind=kind,
        label=label,
        note=note,
        source_document_revision=row.revision,
        source_version_id=source_version_id,
        snapshot=snapshot,
        content_hash=content_hash,
        byte_count=byte_count,
        performed_by=actor_id,
    )
    db.add(version)
    return version


def _store_document(row: SandboxDocumentRow, document: SandboxDocument, actor_id: UUID) -> None:
    payload, content_hash, byte_count = canonical_document(document)
    row.document = payload
    row.content_hash = content_hash
    row.byte_count = byte_count
    row.schema_version = 2
    _advance_revision(row, actor_id)


def _advance_revision(row: SandboxDocumentRow, actor_id: UUID) -> None:
    row.revision += 1
    row.performed_by = actor_id


def _parse_row_document(row: SandboxDocumentRow) -> SandboxDocument:
    return _parse_row_document_payload(row.document)


def _parse_row_document_payload(payload: dict[str, object]) -> SandboxDocument:
    return SandboxDocument.model_validate(payload)


def _document_response(db: Session, row: SandboxDocumentRow) -> DocumentResponse:
    document = _parse_row_document(row)
    latest_published = db.scalar(
        select(SandboxVersion)
        .where(
            SandboxVersion.document_id == row.id,
            SandboxVersion.is_deleted.is_(False),
            SandboxVersion.kind == "published",
        )
        .order_by(SandboxVersion.sequence.desc())
        .limit(1)
    )
    if not isinstance(latest_published, SandboxVersion):
        latest_published = None
    return DocumentResponse(
        document=document,
        revision=row.revision,
        content_hash=row.content_hash,
        byte_count=row.byte_count,
        issues=validate_document(document),
        latest_published_version=(
            PublishedDocumentVersion(
                id=latest_published.id,
                sequence=latest_published.sequence,
                label=latest_published.label,
                created_at=latest_published.created_at,
            )
            if latest_published is not None
            else None
        ),
        published_hash=latest_published.content_hash if latest_published is not None else None,
        has_unpublished_changes=(
            latest_published is None or latest_published.content_hash != row.content_hash
        ),
    )


def _version_response(version: SandboxVersion) -> VersionResponse:
    return VersionResponse(
        id=version.id,
        sequence=version.sequence,
        kind=version.kind,
        label=version.label,
        note=version.note,
        source_document_revision=version.source_document_revision,
        source_version_id=version.source_version_id,
        content_hash=version.content_hash,
        byte_count=version.byte_count,
        metadata_revision=version.metadata_revision,
        created_at=version.created_at,
        performed_by=version.performed_by,
        is_deleted=version.is_deleted,
        deleted_at=version.deleted_at,
    )


def _version_detail(version: SandboxVersion) -> VersionDetailResponse:
    return VersionDetailResponse(
        **_version_response(version).model_dump(),
        document=_parse_row_document_payload(version.snapshot),
    )
