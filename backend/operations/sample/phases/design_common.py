"""Shared request and document helpers for planned Sandbox phases."""

from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any
from uuid import uuid4

from pydantic import ValidationError

from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.validation import validate_document
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _client,
    _id,
    _read_json,
    _record_mapping,
    _request,
    _request_id,
    _request_object,
)
from operations.sample.phases.planning import _design_values, _document_version

if TYPE_CHECKING:
    from operations.sample.blueprint import SampleDataset

_DOCUMENT_ROW_ID: str | None = None
_PAGE_SIZE = 100


def _text(action: PhaseAction, key: str, *, step: str) -> str:
    value = action.values.get(key)
    if not isinstance(value, str) or not value:
        raise SamplePhaseActionError("Planned Sandbox value is invalid", step=step)
    return value


def _canonical_document(value: object, *, step: str) -> dict[str, Any]:
    try:
        document = SandboxDocument.model_validate(value)
    except ValidationError:
        raise SamplePhaseActionError(
            "Sandbox document did not match schema v4", step=step
        ) from None
    if validate_document(document):
        raise SamplePhaseActionError("Sandbox document failed semantic validation", step=step)
    return document.model_dump(mode="json", by_alias=True, exclude_none=True)


def _require_same_document(
    actual: Mapping[str, Any], expected: object, *, step: str
) -> dict[str, Any]:
    expected_document = _canonical_document(expected, step=step)
    if dict(actual) != expected_document:
        raise SamplePhaseActionError("Sandbox draft changed from the planned state", step=step)
    return expected_document


def _load_document(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    on_substep: PhaseSubstep | None,
) -> tuple[dict[str, Any], int]:
    body = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path="/api/sandbox/document",
        step="load_document",
        on_substep=on_substep,
    )
    revision = body.get("revision")
    if type(revision) is not int or revision < 1 or "document" not in body:
        raise SamplePhaseActionError("Sandbox revision could not be read", step="load_document")
    return _canonical_document(body["document"], step="load_document"), revision


def _save_document(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    document: dict[str, Any],
    revision: int,
    *,
    step: str,
    on_substep: PhaseSubstep | None,
) -> int:
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="PUT",
        path="/api/sandbox/document",
        step=step,
        expected=200,
        on_substep=on_substep,
        json_body={"expectedRevision": revision, "document": document},
        primary_entity_type="sandbox_documents",
        primary_entity_id=_DOCUMENT_ROW_ID,
        primary_action="update",
        expected_audit_rows=1,
    )
    body = _read_json(response, step=step, request_id=_request_id(response))
    next_revision = body.get("revision")
    if type(next_revision) is not int or next_revision != revision + 1:
        raise SamplePhaseActionError("Sandbox save did not advance one revision", step=step)
    if _canonical_document(body.get("document"), step=step) != document:
        raise SamplePhaseActionError("Sandbox save returned a different document", step=step)
    return next_revision


def _publish_and_map_version(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    revision: int,
    version_key: str,
    preview_step: str,
    publish_step: str,
    on_substep: PhaseSubstep | None,
) -> None:
    preview_response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path="/api/sandbox/publication-previews",
        step=preview_step,
        expected=200,
        on_substep=on_substep,
        json_body={"expectedRevision": revision},
        expected_audit_rows=0,
    )
    preview = _read_json(
        preview_response, step=preview_step, request_id=_request_id(preview_response)
    )
    token = preview.get("previewToken")
    digest = preview.get("impactDigest")
    blockers = preview.get("blockers")
    if (
        not isinstance(token, str)
        or not token
        or not isinstance(digest, str)
        or len(digest) != 64
        or type(preview.get("documentRevision")) is not int
        or preview["documentRevision"] != revision
        or not isinstance(blockers, list)
        or blockers
    ):
        raise SamplePhaseActionError(
            "Sandbox publication preview did not match its draft", step=preview_step
        )
    publish_body: dict[str, Any] = {
        "expectedRevision": revision,
        "previewToken": token,
        "impactDigest": digest,
        "password": context.admin_password,
    }
    note = action.values.get("note")
    if isinstance(note, str) and note:
        publish_body["note"] = note
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path="/api/sandbox/publications",
        step=publish_step,
        expected=action.expected_status,
        on_substep=on_substep,
        json_body=publish_body,
        headers={"Idempotency-Key": str(uuid4())},
        primary_entity_type="sandbox_versions",
        primary_entity_id=None,
        primary_action="create",
        expected_audit_rows=1,
        related_entity_types=("sandbox_publications",),
    )
    body = _read_json(response, step=publish_step, request_id=_request_id(response))
    version = body.get("version")
    if not isinstance(version, dict) or version.get("kind") != "published":
        raise SamplePhaseActionError(
            "Sandbox publish response had no published version", step=publish_step
        )
    version_id = _id(
        {"version": version.get("id")},
        "version",
        label="published Sandbox version",
        step=publish_step,
    )
    evidence[-1]["primary_entity_id"] = version_id
    _record_new_mapping(context, action, "sandbox_versions", version_key, version_id, mappings)


def _list_items(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    *,
    path: str,
    params: Mapping[str, Any],
    step: str,
    on_substep: PhaseSubstep | None,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    offset = 0
    while True:
        body = _request_object(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            path=path,
            params={**params, "limit": _PAGE_SIZE, "offset": offset},
            step=step,
            on_substep=on_substep,
        )
        page = body.get("items")
        pagination = body.get("pagination")
        if not isinstance(page, list) or not isinstance(pagination, dict):
            raise SamplePhaseActionError("Sandbox list response was invalid", step=step)
        if any(not isinstance(item, dict) for item in page):
            raise SamplePhaseActionError("Sandbox list contained an invalid row", step=step)
        items.extend(page)
        has_more = pagination.get("has_more")
        total = pagination.get("total")
        if type(has_more) is not bool or type(total) is not int or total < len(items):
            raise SamplePhaseActionError("Sandbox pagination was invalid", step=step)
        if not has_more:
            if total != len(items):
                raise SamplePhaseActionError("Sandbox list was incomplete", step=step)
            return items
        if not page:
            raise SamplePhaseActionError("Sandbox pagination made no progress", step=step)
        offset += len(page)


def _record_new_mapping(
    context: PhaseExecutionContext,
    action: PhaseAction,
    kind: str,
    logical_id: str,
    server_id: str,
    output: list[dict[str, str]],
) -> None:
    if logical_id in context.runtime_mappings.get(kind, {}):
        raise SamplePhaseActionError("Planned Sandbox mapping already exists", step=action.key)
    client = _client(context, action.actor_key, step="record_mapping")
    _record_mapping(context, client, kind, logical_id, server_id, output)


def _expected_design_document(dataset: SampleDataset, *, closed: bool = False) -> dict[str, Any]:
    phase_data = dataset.organization.phases
    if phase_data is None:
        raise SamplePhaseActionError("Pack has no planned Sandbox phase", step="load_document")
    values = _design_values(dataset)
    return _canonical_document(
        _document_version(
            dataset,
            phase_data.design,
            plan_values=values,
            closed=closed,
        ),
        step="validate_planned_document",
    )
