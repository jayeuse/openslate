import json
from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.sandbox.designs.service as designs_service
from app.systems.sandbox.designs.models import SandboxDocument as SandboxDocumentRow
from app.systems.sandbox.designs.models import SandboxVersion
from app.systems.sandbox.designs.schemas import PortableBundle
from app.systems.sandbox.designs.service import (
    IMPORT_ENVELOPE_ALLOWANCE_BYTES,
    SandboxDesignError,
    canonical_document,
    export_bundle,
    portable_bundle_bytes,
)
from tests.sandbox_designs.fixtures import sample_document


def _document_row() -> SandboxDocumentRow:
    document = sample_document()
    payload, content_hash, byte_count = canonical_document(document)
    return SandboxDocumentRow(
        id=uuid7(),
        singleton_key=True,
        schema_version=2,
        revision=1,
        document=payload,
        content_hash=content_hash,
        byte_count=byte_count,
    )


def test_export_bundles_preserve_required_null_values_and_round_trip() -> None:
    row = _document_row()
    db = Mock(spec=Session)
    db.scalar.return_value = row

    without_history = export_bundle(db, include_versions=False)
    without_history_bytes = portable_bundle_bytes(without_history)
    without_history_text = without_history_bytes.decode()
    without_history_payload = json.loads(without_history_bytes)

    assert without_history_text.startswith('{\n  "automations": [')
    assert without_history_text.endswith("\n")
    assert "versions" not in without_history_payload
    assert (
        without_history_payload["design"]["modules"][0]["fields"][2]["config"]["defaultValue"]
        is None
    )
    assert PortableBundle.model_validate(without_history_payload) == without_history

    now = datetime.now(UTC)
    version = SandboxVersion(
        id=uuid7(),
        document_id=row.id,
        sequence=1,
        kind="checkpoint",
        label="Initial checkpoint",
        note=None,
        source_document_revision=1,
        snapshot=row.document,
        content_hash=row.content_hash,
        byte_count=row.byte_count,
        metadata_revision=1,
        created_at=now,
        updated_at=now,
    )
    db.scalars.return_value.all.return_value = [version]
    with_history = export_bundle(db, include_versions=True)
    with_history_payload = json.loads(portable_bundle_bytes(with_history))

    assert with_history_payload["versions"][0]["note"] is None
    assert (
        with_history_payload["versions"][0]["document"]["design"]["modules"][0]["fields"][2][
            "config"
        ]["defaultValue"]
        is None
    )
    assert PortableBundle.model_validate(with_history_payload) == with_history


def test_export_history_includes_published_versions_beyond_the_mutable_limit() -> None:
    row = _document_row()
    db = Mock(spec=Session)
    db.scalar.return_value = row
    now = datetime.now(UTC)
    versions = [
        SandboxVersion(
            id=uuid7(),
            document_id=row.id,
            sequence=sequence,
            kind="checkpoint" if sequence <= 50 else "published",
            label=f"Version {sequence}",
            note=None,
            source_document_revision=1,
            snapshot=row.document,
            content_hash=row.content_hash,
            byte_count=row.byte_count,
            metadata_revision=1,
            created_at=now,
            updated_at=now,
        )
        for sequence in range(1, 52)
    ]
    db.scalars.return_value.all.return_value = versions

    bundle = export_bundle(db, include_versions=True)

    assert bundle.versions is not None
    assert len(bundle.versions) == 51
    assert bundle.versions[-1].kind == "published"


def test_portable_bundle_reserves_import_envelope_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    bundle = PortableBundle.model_validate(sample_document().model_dump(by_alias=True))
    size = len(portable_bundle_bytes(bundle))
    monkeypatch.setattr(
        designs_service, "MAX_DOCUMENT_BYTES", size + IMPORT_ENVELOPE_ALLOWANCE_BYTES
    )

    designs_service._assert_portable_bundle_size(bundle)

    monkeypatch.setattr(
        designs_service, "MAX_DOCUMENT_BYTES", size + IMPORT_ENVELOPE_ALLOWANCE_BYTES - 1
    )
    with pytest.raises(SandboxDesignError, match="Sandbox export exceeds 5 MiB"):
        designs_service._assert_portable_bundle_size(bundle)
