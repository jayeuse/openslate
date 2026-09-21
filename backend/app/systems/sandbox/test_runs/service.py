"""Persistence boundary for Sandbox temporary-input test evidence."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import cast
from uuid import UUID

from pydantic import BaseModel, ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.systems.sandbox.designs.models import SandboxDocument as SandboxDocumentRow
from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.test_runs.evaluator import evaluate_test
from app.systems.sandbox.test_runs.models import SandboxTestRun
from app.systems.sandbox.test_runs.results import SandboxTestResult
from app.systems.sandbox.test_runs.schemas import (
    SandboxTestResultResponse,
    SandboxTestRunCreateRequest,
    SandboxTestRunListResponse,
    SandboxTestRunResponse,
)

MAX_ACTIVE_RUNS = 50
MAX_EVIDENCE_BYTES = 5 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class SandboxTestError(Exception):
    code: str
    message: str
    status_code: int


def create_run(
    db: Session, *, actor_id: UUID, payload: SandboxTestRunCreateRequest
) -> SandboxTestRunResponse:
    """Lock the draft, evaluate temporary values, and save only the evidence."""

    document_row = _locked_document(db, payload.expected_revision)
    document = _parse_document(document_row)
    if _active_run_count(db, document_row.id) >= MAX_ACTIVE_RUNS:
        raise SandboxTestError(
            "run_history_full", "Test history is full; clear saved results before continuing.", 409
        )
    input_values = _json_value(payload.values, "test input values")
    event = _json_model(payload.event)
    try:
        result = evaluate_test(
            document=document,
            module_id=payload.module_id,
            values=payload.values,
            event=event,
            automation_ids=payload.automation_ids,
        )
    except ValueError as error:
        raise SandboxTestError("test_invalid", "Sandbox test settings are invalid.", 422) from error
    result_payload = _result_payload(result)
    byte_count = _evidence_byte_count(
        input_values=input_values,
        event=event,
        automation_ids=payload.automation_ids,
        result=result_payload,
    )
    run = SandboxTestRun(
        document_id=document_row.id,
        document_revision=document_row.revision,
        document_hash=document_row.content_hash,
        module_id=payload.module_id,
        input_values=input_values,
        event=event,
        automation_ids=None if payload.automation_ids is None else list(payload.automation_ids),
        result=result_payload,
        result_byte_count=byte_count,
        performed_by=actor_id,
    )
    db.add(run)
    db.flush()
    response = _run_response(run)
    db.commit()
    return response


def list_runs(db: Session, *, limit: int, offset: int) -> SandboxTestRunListResponse:
    statement = (
        select(SandboxTestRun)
        .where(SandboxTestRun.is_deleted.is_(False))
        .order_by(SandboxTestRun.created_at.desc(), SandboxTestRun.id.desc())
    )
    total = int(db.scalar(select(func.count()).select_from(statement.subquery())) or 0)
    runs = list(db.scalars(statement.limit(limit).offset(offset)).all())
    return SandboxTestRunListResponse(
        items=[_run_response(run) for run in runs],
        limit=limit,
        offset=offset,
        count=len(runs),
        total=total,
        has_more=offset + len(runs) < total,
    )


def read_run(db: Session, run_id: UUID) -> SandboxTestRunResponse:
    run = db.scalar(
        select(SandboxTestRun).where(
            SandboxTestRun.id == run_id,
            SandboxTestRun.is_deleted.is_(False),
        )
    )
    if run is None:
        raise SandboxTestError("run_not_found", "Saved test result was not found.", 404)
    return _run_response(run)


def clear_runs(db: Session, *, actor_id: UUID) -> None:
    """Soft-delete each saved test result without modifying the draft."""

    runs = list(
        db.scalars(
            select(SandboxTestRun).where(SandboxTestRun.is_deleted.is_(False)).with_for_update()
        ).all()
    )
    if not runs:
        return
    now = datetime.now(UTC)
    for run in runs:
        run.is_deleted = True
        run.deleted_at = now
        run.performed_by = actor_id
    db.commit()


def _locked_document(db: Session, expected_revision: int) -> SandboxDocumentRow:
    document = db.scalar(
        select(SandboxDocumentRow)
        .where(SandboxDocumentRow.singleton_key.is_(True))
        .with_for_update()
    )
    if document is None:
        raise SandboxTestError("document_unavailable", "Sandbox draft is unavailable.", 503)
    if document.revision != expected_revision:
        raise SandboxTestError(
            "stale_revision", "Sandbox draft changed; reload before testing.", 409
        )
    return document


def _parse_document(row: SandboxDocumentRow) -> SandboxDocument:
    try:
        return SandboxDocument.model_validate(row.document)
    except ValidationError as error:
        raise SandboxTestError(
            "document_invalid", "Sandbox draft cannot be tested.", 409
        ) from error


def _active_run_count(db: Session, document_id: UUID) -> int:
    return int(
        db.scalar(
            select(func.count()).where(
                SandboxTestRun.document_id == document_id,
                SandboxTestRun.is_deleted.is_(False),
            )
        )
        or 0
    )


def _json_model(model: BaseModel) -> dict[str, object]:
    return cast(dict[str, object], model.model_dump(by_alias=True, mode="json", exclude_none=True))


def _json_value(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise SandboxTestError("test_invalid", f"{label.capitalize()} are invalid.", 422)
    return cast(dict[str, object], value)


def _result_payload(result: SandboxTestResult) -> dict[str, object]:
    response = SandboxTestResultResponse.model_validate(
        {
            "values": result.values,
            "routes": [
                {"label": route.label, **({"detail": route.detail} if route.detail else {})}
                for route in result.routes
            ],
            "automationTraces": [
                {
                    "automationId": trace.automation_id,
                    "label": trace.label,
                    "outcome": trace.outcome,
                }
                for trace in result.automation_traces
            ],
            "issues": [
                {
                    "code": issue.code,
                    "message": issue.message,
                    "targetId": issue.target_id,
                }
                for issue in result.issues
            ],
        }
    )
    return _json_model(response)


def _evidence_byte_count(
    *,
    input_values: dict[str, object],
    event: dict[str, object],
    automation_ids: list[str] | None,
    result: dict[str, object],
) -> int:
    encoded = json.dumps(
        {
            "input": input_values,
            "event": event,
            "automationIds": automation_ids,
            "result": result,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    if len(encoded) > MAX_EVIDENCE_BYTES:
        raise SandboxTestError("evidence_too_large", "Test result exceeds 5 MiB.", 413)
    return len(encoded)


def _run_response(run: SandboxTestRun) -> SandboxTestRunResponse:
    try:
        return SandboxTestRunResponse.model_validate(
            {
                "id": run.id,
                "createdAt": run.created_at,
                "documentRevision": run.document_revision,
                "input": {"moduleId": run.module_id, "values": run.input_values},
                "event": run.event,
                "automationIds": run.automation_ids,
                "result": run.result,
            }
        )
    except ValidationError as error:
        raise SandboxTestError("run_invalid", "Saved test result is invalid.", 409) from error
