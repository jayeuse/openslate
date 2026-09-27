from datetime import UTC, datetime
from unittest.mock import Mock
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

import app.systems.sandbox.designs.service as service
from app.systems.sandbox.designs.models import SandboxDocument as SandboxDocumentRow
from app.systems.sandbox.designs.models import SandboxVersion
from app.systems.sandbox.designs.schemas import PortableBundle
from app.systems.sandbox.designs.service import SandboxDesignError
from tests.sandbox_designs.fixtures import sample_document


def _row(*, revision: int = 1) -> SandboxDocumentRow:
    document = sample_document()
    payload, content_hash, byte_count = service.canonical_document(document)
    return SandboxDocumentRow(
        id=uuid4(),
        singleton_key=True,
        schema_version=3,
        revision=revision,
        document=payload,
        content_hash=content_hash,
        byte_count=byte_count,
    )


def _version(
    row: SandboxDocumentRow,
    *,
    kind: str = "checkpoint",
    sequence: int = 1,
) -> SandboxVersion:
    now = datetime.now(UTC)
    return SandboxVersion(
        id=uuid4(),
        document_id=row.id,
        sequence=sequence,
        kind=kind,
        label=f"Version {sequence}",
        note=None,
        source_document_revision=row.revision,
        source_version_id=None,
        snapshot=row.document,
        content_hash=row.content_hash,
        byte_count=row.byte_count,
        metadata_revision=1,
        created_at=now,
        updated_at=now,
        performed_by=None,
        is_deleted=False,
        deleted_at=None,
    )


def _bundle_with_version() -> PortableBundle:
    document = sample_document()
    payload = document.model_dump(by_alias=True, mode="json")
    payload["versions"] = [
        {
            "id": "portable-1",
            "label": "Imported checkpoint",
            "kind": "checkpoint",
            "document": document.model_dump(
                by_alias=True,
                mode="json",
                exclude={"kind", "schema_version"},
            ),
            "published": False,
            "date": "2026-09-21T00:00:00Z",
            "note": None,
        }
    ]
    return PortableBundle.model_validate(payload)


def test_document_and_version_lookup_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    db = Mock(spec=Session)
    db.scalar.return_value = None

    with pytest.raises(SandboxDesignError) as missing_document:
        service._document_row(db, lock=True)
    assert missing_document.value.code == "document_unavailable"

    with pytest.raises(SandboxDesignError) as missing_version:
        service._active_version(db, uuid4(), lock=True)
    assert missing_version.value.code == "version_not_found"

    monkeypatch.setattr(service, "MAX_DOCUMENT_BYTES", 1)
    with pytest.raises(SandboxDesignError) as oversized:
        service.canonical_document(sample_document())
    assert oversized.value.status_code == 413


def test_checkpoint_api_rejects_release_and_append_limits_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = _row()
    db = Mock(spec=Session)
    monkeypatch.setattr(service, "_locked_document", lambda *_args: row)
    with pytest.raises(SandboxDesignError) as invalid_release:
        service.create_version(
            db,
            actor_id=uuid4(),
            expected_revision=1,
            kind="release",
            label="Release",
            note=None,
        )
    assert invalid_release.value.code == "version_kind_not_allowed"

    monkeypatch.setattr(service, "_active_version_count", lambda *_args, **_kwargs: 50)
    with pytest.raises(SandboxDesignError) as full_history:
        service._append_version(
            db,
            row=row,
            document=sample_document(),
            kind="checkpoint",
            label="Full",
            note=None,
            actor_id=uuid4(),
        )
    assert full_history.value.code == "version_limit"


def test_published_versions_do_not_consume_checkpoint_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = _row()
    db = Mock(spec=Session)
    monkeypatch.setattr(service, "_active_version_count", lambda *_args, **_kwargs: 50)
    db.scalar.return_value = 0

    published = service._append_version(
        db,
        row=row,
        document=sample_document(),
        kind="published",
        label="Release 51",
        note=None,
        actor_id=uuid4(),
    )

    assert published.kind == "published"
    db.add.assert_called_once_with(published)


def test_version_listing_read_and_metadata_update(monkeypatch: pytest.MonkeyPatch) -> None:
    row = _row()
    version = _version(row)
    db = Mock(spec=Session)
    db.scalar.return_value = 2
    db.scalars.return_value.all.return_value = [version]

    page = service.list_versions(db, limit=1, offset=0)
    assert page.count == 1
    assert page.total == 2
    assert page.has_more is True

    monkeypatch.setattr(service, "_active_version", lambda *_args, **_kwargs: version)
    assert service.read_version(db, version.id).id == version.id
    monkeypatch.setattr(service, "_locked_document", lambda *_args: row)
    monkeypatch.setattr(service, "_document_row", lambda *_args, **_kwargs: row)

    actor_id = uuid4()
    updated = service.update_version_metadata(
        db,
        actor_id=actor_id,
        version_id=version.id,
        expected_revision=1,
        label="Renamed",
        note="A note",
        update_note=True,
    )
    assert (updated.label, updated.note, updated.metadata_revision) == (
        "Renamed",
        "A note",
        2,
    )
    assert row.revision == 2
    db.commit.assert_called_once()

    version.kind = "published"
    with pytest.raises(SandboxDesignError) as immutable:
        service.update_version_metadata(
            db,
            actor_id=actor_id,
            version_id=version.id,
            expected_revision=2,
            label="No",
            note=None,
            update_note=False,
        )
    assert immutable.value.code == "version_immutable"


def test_delete_version_protections_and_success(monkeypatch: pytest.MonkeyPatch) -> None:
    row = _row()
    version = _version(row)
    db = Mock(spec=Session)
    monkeypatch.setattr(service, "_locked_document", lambda *_args: row)
    monkeypatch.setattr(service, "_active_version", lambda *_args, **_kwargs: version)

    monkeypatch.setattr(service, "_active_version_count", lambda *_args, **_kwargs: 1)
    with pytest.raises(SandboxDesignError, match="sole version"):
        service.delete_version(db, actor_id=uuid4(), version_id=version.id, expected_revision=1)

    monkeypatch.setattr(service, "_active_version_count", lambda *_args, **_kwargs: 2)
    version.kind = "published"
    with pytest.raises(SandboxDesignError, match="Published versions"):
        service.delete_version(db, actor_id=uuid4(), version_id=version.id, expected_revision=1)

    version.kind = "checkpoint"
    actor_id = uuid4()
    service.delete_version(db, actor_id=actor_id, version_id=version.id, expected_revision=1)
    assert version.is_deleted is True
    assert version.deleted_at is not None
    assert version.performed_by == actor_id
    assert row.revision == 2
    db.commit.assert_called_once()


def test_restore_changes_only_draft_and_never_creates_a_rollback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = _row()
    checkpoint = _version(row)
    db = Mock(spec=Session)
    monkeypatch.setattr(service, "_locked_document", lambda *_args: row)
    monkeypatch.setattr(service, "_active_version", lambda *_args, **_kwargs: checkpoint)

    monkeypatch.setattr(service, "_active_version_count", lambda *_args, **_kwargs: 50)
    with pytest.raises(SandboxDesignError) as full:
        service.restore_version(
            db,
            actor_id=uuid4(),
            version_id=checkpoint.id,
            expected_revision=1,
        )
    assert full.value.code == "version_limit"

    appended: list[dict[str, object]] = []
    monkeypatch.setattr(service, "_active_version_count", lambda *_args, **_kwargs: 1)
    monkeypatch.setattr(
        service,
        "_append_version",
        lambda _db, **kwargs: appended.append(kwargs),
    )
    response = service.restore_version(
        db,
        actor_id=uuid4(),
        version_id=checkpoint.id,
        expected_revision=1,
    )
    assert response.revision == 2
    assert [entry["kind"] for entry in appended] == ["checkpoint"]


def test_import_enforces_capacity_and_retains_portable_history(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = _row()
    bundle = _bundle_with_version()
    db = Mock(spec=Session)
    monkeypatch.setattr(service, "_locked_document", lambda *_args: row)
    monkeypatch.setattr(service, "_active_version_count", lambda *_args, **_kwargs: 49)

    with pytest.raises(SandboxDesignError) as full:
        service.import_bundle(db, actor_id=uuid4(), expected_revision=1, bundle=bundle)
    assert full.value.code == "version_limit"

    appended: list[dict[str, object]] = []
    monkeypatch.setattr(service, "_active_version_count", lambda *_args, **_kwargs: 1)
    monkeypatch.setattr(
        service,
        "_append_version",
        lambda _db, **kwargs: appended.append(kwargs),
    )
    response = service.import_bundle(db, actor_id=uuid4(), expected_revision=1, bundle=bundle)
    assert response.revision == 2
    assert [entry["kind"] for entry in appended] == ["checkpoint", "imported"]
    assert appended[1]["label"] == "Imported checkpoint"
    db.commit.assert_called_once()
