"""Service boundaries for saved Sandbox temporary-input tests."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.sandbox.designs.models import SandboxDocument as SandboxDocumentRow
from app.systems.sandbox.test_runs.models import SandboxTestRun
from app.systems.sandbox.test_runs.schemas import SandboxTestRunCreateRequest
from app.systems.sandbox.test_runs.service import (
    MAX_ACTIVE_RUNS,
    SandboxTestError,
    clear_runs,
    create_run,
    list_runs,
    read_run,
)
from tests.sandbox_test_runs.fixtures import sandbox_document


def test_create_persists_an_immutable_temporary_input_snapshot() -> None:
    row = _document_row()
    database = _database(row, active_runs=0)

    response = create_run(database, actor_id=uuid7(), payload=_request())

    run = database.add.call_args.args[0]
    assert isinstance(run, SandboxTestRun)
    assert run.document_id == row.id
    assert run.document_revision == 1
    assert run.document_hash == row.content_hash
    assert run.module_id == "requests"
    assert run.input_values == {"priority": "High", "status": "", "score": 0}
    assert run.automation_ids is None
    assert response.result.values["status"] == "Triaged"
    assert response.result.values["score"] == 10
    assert database.add.call_count == 1
    assert database.flush.call_count == 1
    assert database.commit.call_count == 1


def test_create_rejects_stale_documents_full_history_and_invalid_persisted_document() -> None:
    stale = _document_row()
    stale.revision = 2
    stale_database = Mock(spec=Session)
    stale_database.scalar.return_value = stale
    with pytest.raises(SandboxTestError) as stale_error:
        create_run(stale_database, actor_id=uuid7(), payload=_request())
    assert stale_error.value.code == "stale_revision"

    full_database = _database(_document_row(), active_runs=MAX_ACTIVE_RUNS)
    with pytest.raises(SandboxTestError) as full_error:
        create_run(full_database, actor_id=uuid7(), payload=_request())
    assert full_error.value.code == "run_history_full"

    invalid = _document_row()
    invalid.document = {"kind": "openslate-sandbox"}
    invalid_database = Mock(spec=Session)
    invalid_database.scalar.return_value = invalid
    with pytest.raises(SandboxTestError) as invalid_error:
        create_run(invalid_database, actor_id=uuid7(), payload=_request())
    assert invalid_error.value.code == "document_invalid"


def test_detail_fails_closed_for_malformed_saved_json_and_clear_uses_instance_mutations() -> None:
    database = _database(_document_row(), active_runs=0)
    create_run(database, actor_id=uuid7(), payload=_request())
    run = database.add.call_args.args[0]
    run.result = {"values": "invalid"}
    detail_database = Mock(spec=Session)
    detail_database.scalar.return_value = run

    with pytest.raises(SandboxTestError) as invalid_error:
        read_run(detail_database, run.id)
    assert invalid_error.value.code == "run_invalid"

    clear_database = Mock(spec=Session)
    clear_database.scalars.return_value.all.return_value = [run]
    actor_id = uuid7()
    clear_runs(clear_database, actor_id=actor_id)
    assert run.is_deleted is True
    assert run.deleted_at is not None
    assert run.performed_by == actor_id
    clear_database.commit.assert_called_once()


def test_list_returns_offset_metadata_and_missing_detail_is_not_found() -> None:
    database = _database(_document_row(), active_runs=0)
    created = create_run(database, actor_id=uuid7(), payload=_request())
    run = database.add.call_args.args[0]

    list_database = Mock(spec=Session)
    list_database.scalar.return_value = 2
    list_database.scalars.return_value.all.return_value = [run]
    page = list_runs(list_database, limit=1, offset=0)
    assert (page.count, page.total, page.has_more) == (1, 2, True)
    assert page.items[0].id == created.id

    missing_database = Mock(spec=Session)
    missing_database.scalar.return_value = None
    with pytest.raises(SandboxTestError) as missing_error:
        read_run(missing_database, uuid7())
    assert missing_error.value.code == "run_not_found"


def _request() -> SandboxTestRunCreateRequest:
    return SandboxTestRunCreateRequest.model_validate(
        {
            "expectedRevision": 1,
            "moduleId": "requests",
            "values": {"priority": "High", "status": "", "score": 0},
            "event": {"kind": "record-created"},
        }
    )


def _document_row() -> SandboxDocumentRow:
    document = sandbox_document()
    return SandboxDocumentRow(
        id=uuid7(),
        singleton_key=True,
        schema_version=2,
        revision=1,
        document=document.model_dump(by_alias=True, mode="json"),
        content_hash="0" * 64,
        byte_count=1,
    )


def _database(row: SandboxDocumentRow, *, active_runs: int) -> Mock:
    database = Mock(spec=Session)
    database.scalar.side_effect = [row, active_runs]

    def refresh(run: object) -> None:
        run.id = uuid7()  # type: ignore[attr-defined]
        run.created_at = datetime.now(UTC)  # type: ignore[attr-defined]
        run.is_deleted = False  # type: ignore[attr-defined]

    database.flush.side_effect = lambda: refresh(database.add.call_args.args[0])
    return database
