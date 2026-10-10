"""History export proof and the existing history-free Sandbox import action."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import ValidationError

from app.systems.sandbox.designs.schemas import (
    DocumentResponse,
    PortableBundle,
    VersionDetailResponse,
    VersionListResponse,
)
from operations.sample.controls.sandbox import _IMPORT_CHECKPOINT_KEY, _revision, _version_list
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    SamplePhaseActionError,
    _id,
    _read_json,
    _record_mapping,
    _request,
    _request_id,
    _result,
)

_MAX_BYTES = 5 * 1024 * 1024
_READ_KEYS = {
    "actor_id",
    "method",
    "path",
    "params",
    "status",
    "content_type",
    "request_id",
    "headers",
    "payload",
    "sha256",
}


def _refuse() -> ValueError:
    return ValueError("Sandbox history export did not match its independent source reads")


def _body(read: object, path: str, params: dict[str, str], actor: str, seen: set[str]) -> str:
    if not isinstance(read, dict) or set(read) != _READ_KEYS:
        raise _refuse()
    payload, headers, request_id = read.get("payload"), read.get("headers"), read.get("request_id")
    if (
        read.get("actor_id") != actor
        or read.get("method") != "GET"
        or read.get("path") != path
        or read.get("params") != params
        or type(read.get("status")) is not int
        or read["status"] != 200
        or not isinstance(payload, str)
        or len(payload.encode()) > _MAX_BYTES
        or not isinstance(headers, dict)
        or set(headers) != {"content-type", "x-request-id"}
        or read.get("content_type") != headers.get("content-type")
        or not isinstance(read.get("content_type"), str)
        or read["content_type"].split(";")[0].strip().lower() != "application/json"
        or not isinstance(request_id, str)
        or str(UUID(request_id)) != request_id
        or request_id in seen
        or headers.get("x-request-id") != request_id
        or read.get("sha256") != hashlib.sha256(payload.encode()).hexdigest()
    ):
        raise _refuse()
    seen.add(request_id)
    return payload


def _page(payload: str) -> VersionListResponse:
    page = VersionListResponse.model_validate_json(payload, strict=True)
    if (
        page.limit != 100
        or page.offset != 0
        or page.count != len(page.items)
        or page.total != page.count
        or page.has_more
        or page.count > 100
        or len({row.id for row in page.items}) != page.count
        or [row.sequence for row in page.items]
        != sorted({row.sequence for row in page.items}, reverse=True)
        or any(
            row.sequence < 1
            or row.is_deleted
            or row.deleted_at is not None
            or row.kind not in {"checkpoint", "published", "imported"}
            for row in page.items
        )
        or page.mutable_count != sum(row.kind != "published" for row in page.items)
    ):
        raise _refuse()
    return page


def _snapshot(
    raw: object, actor: str, seen: set[str]
) -> tuple[DocumentResponse, list[VersionDetailResponse]]:
    if not isinstance(raw, dict) or set(raw) != {"document", "versions", "details"}:
        raise _refuse()
    document = DocumentResponse.model_validate_json(
        _body(raw["document"], "/api/sandbox/document", {}, actor, seen), strict=True
    )
    if document.revision < 1:
        raise _refuse()
    page = _page(
        _body(
            raw["versions"], "/api/sandbox/versions", {"limit": "100", "offset": "0"}, actor, seen
        )
    )
    reads = raw["details"]
    if not isinstance(reads, list) or len(reads) != page.count:
        raise _refuse()
    details = []
    for row, read in zip(page.items, reads, strict=True):
        detail = VersionDetailResponse.model_validate_json(
            _body(read, f"/api/sandbox/versions/{row.id}", {}, actor, seen), strict=True
        )
        if (
            detail.model_dump(exclude={"document"}) != row.model_dump()
            or detail.source_document_revision < 1
            or detail.metadata_revision < 1
            or detail.byte_count < 1
            or re.fullmatch(r"[a-f0-9]{64}", detail.content_hash) is None
            or detail.created_at.utcoffset() is None
        ):
            raise _refuse()
        details.append(detail)
    return document, details


def validate_history_export_reads(raw: object, actor_id: str) -> set[str]:
    """Revalidate complete raw bodies and actual request/response bindings; no success flag."""
    if not isinstance(raw, dict) or set(raw) != {
        "before",
        "without_history",
        "with_history",
        "after",
    }:
        raise _refuse()
    seen: set[str] = set()
    before, details = _snapshot(raw["before"], actor_id, seen)
    without_text = _body(
        raw["without_history"], "/api/sandbox/export", {"includeVersions": "false"}, actor_id, seen
    )
    without = PortableBundle.model_validate_json(without_text, strict=True)
    with_history = PortableBundle.model_validate_json(
        _body(
            raw["with_history"], "/api/sandbox/export", {"includeVersions": "true"}, actor_id, seen
        ),
        strict=True,
    )
    expected_document = before.document.model_dump(mode="json", by_alias=True)
    if (
        "versions" in json.loads(without_text)
        or without.versions is not None
        or without.model_dump(mode="json", by_alias=True, exclude={"versions"}) != expected_document
        or with_history.model_dump(mode="json", by_alias=True, exclude={"versions"})
        != expected_document
        or with_history.versions is None
        or len(with_history.versions) != len(details)
    ):
        raise _refuse()
    for exported, detail in zip(
        with_history.versions, sorted(details, key=lambda row: row.sequence), strict=True
    ):
        instant = datetime.fromisoformat(exported.date)
        if (
            exported.id != str(detail.id)
            or exported.label != detail.label
            or exported.kind != detail.kind
            or exported.note != detail.note
            or exported.published != (detail.kind == "published")
            or instant.utcoffset() is None
            or instant != detail.created_at
            or exported.document.model_dump(mode="json", by_alias=True)
            != detail.document.model_dump(
                mode="json", by_alias=True, exclude={"kind", "schema_version"}
            )
        ):
            raise _refuse()
    after, later_details = _snapshot(raw["after"], actor_id, seen)
    if after != before or later_details != details:
        raise _refuse()
    return seen


def _read(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    path: str,
    step: str,
    on_substep: Callable[[str], None] | None,
    params: dict[str, str] | None = None,
) -> dict[str, Any]:
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="GET",
        path=path,
        step=step,
        expected=200,
        on_substep=on_substep,
        params=params,
    )
    return {
        "actor_id": _id(context.user_ids, action.actor_key, label="user", step=step),
        "method": response.request.method,
        "path": response.request.url.path,
        "params": dict(response.request.url.params),
        "status": response.status_code,
        "content_type": response.headers.get("content-type"),
        "request_id": _request_id(response),
        "headers": {key: response.headers.get(key) for key in ("content-type", "x-request-id")},
        "payload": response.content.decode("utf-8"),
        "sha256": hashlib.sha256(response.content).hexdigest(),
    }


def _read_snapshot(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    when: str,
    on_substep: Callable[[str], None] | None,
) -> dict[str, Any]:
    actor = _id(context.user_ids, action.actor_key, label="user", step="history_export_proof")
    document = _read(
        action, context, evidence, "/api/sandbox/document", f"history_document_{when}", on_substep
    )
    versions = _read(
        action,
        context,
        evidence,
        "/api/sandbox/versions",
        f"history_versions_{when}",
        on_substep,
        {"limit": "100", "offset": "0"},
    )
    page = _page(
        _body(versions, "/api/sandbox/versions", {"limit": "100", "offset": "0"}, actor, set())
    )
    details = [
        _read(
            action,
            context,
            evidence,
            f"/api/sandbox/versions/{row.id}",
            f"history_detail_{when}:{row.id}",
            on_substep,
        )
        for row in page.items
    ]
    snapshot = {"document": document, "versions": versions, "details": details}
    _snapshot(snapshot, actor, set())
    return snapshot


def execute_export_import(
    action: PhaseAction,
    context: PhaseExecutionContext,
    evidence: list[dict[str, object]],
    mappings: list[dict[str, str]],
    *,
    on_substep: Callable[[str], None] | None,
) -> dict[str, object]:
    """Prove the nonmutating history variant before the one existing history-free import."""
    try:
        before = _read_snapshot(action, context, evidence, "before", on_substep)
        without = _read(
            action,
            context,
            evidence,
            "/api/sandbox/export",
            "export_document",
            on_substep,
            {"includeVersions": "false"},
        )
        history = _read(
            action,
            context,
            evidence,
            "/api/sandbox/export",
            "export_document_with_history",
            on_substep,
            {"includeVersions": "true"},
        )
        after = _read_snapshot(action, context, evidence, "after", on_substep)
        proof = {
            "before": before,
            "without_history": without,
            "with_history": history,
            "after": after,
        }
        validate_history_export_reads(
            proof,
            _id(context.user_ids, action.actor_key, label="user", step="history_export_proof"),
        )
    except (ValidationError, ValueError, TypeError, KeyError, UnicodeError):
        raise SamplePhaseActionError(
            "Sandbox history export proof was incomplete or changed", step="history_export_proof"
        ) from None
    bundle = json.loads(without["payload"])
    revision = DocumentResponse.model_validate_json(
        before["document"]["payload"], strict=True
    ).revision
    before_ids = {
        str(row.id)
        for row in VersionListResponse.model_validate_json(
            before["versions"]["payload"], strict=True
        ).items
    }
    if not before_ids:
        raise SamplePhaseActionError(
            "Sandbox import needs an existing version so its review checkpoint can be removed",
            step="history_export_import_precondition",
        )
    response = _request(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        method="POST",
        path="/api/sandbox/imports",
        step="import_document",
        expected=action.expected_status,
        on_substep=on_substep,
        json_body={"expectedRevision": revision, "bundle": bundle},
        primary_entity_type="sandbox_documents",
        primary_action="update",
        expected_audit_rows=1,
        related_entity_types=("sandbox_versions",),
    )
    imported = _read_json(response, step="import_document")
    if not isinstance(imported.get("document"), dict) or imported["document"] != bundle:
        raise SamplePhaseActionError(
            "Sandbox import changed the exported document", step="import_document"
        )
    next_revision = _revision(imported, step="import_document")
    after_versions = _version_list(
        action, context, evidence, step="list_versions_after_import", on_substep=on_substep
    )
    new_checkpoints = [
        row
        for row in after_versions
        if row.get("id") not in before_ids
        and row.get("kind") == "checkpoint"
        and row.get("label") == "Before import"
    ]
    if len(new_checkpoints) != 1 or not isinstance(new_checkpoints[0].get("id"), str):
        raise SamplePhaseActionError(
            "Sandbox import did not create one review checkpoint", step="list_versions_after_import"
        )
    checkpoint_id = _id(
        {"version": new_checkpoints[0]["id"]},
        "version",
        label="Sandbox version",
        step="list_versions_after_import",
    )
    _record_mapping(
        context,
        context.clients[action.actor_key],
        "sandbox_control_versions",
        _IMPORT_CHECKPOINT_KEY,
        checkpoint_id,
        mappings,
    )
    evidence[-1]["primary_entity_id"] = None
    return _result(
        action,
        context,
        evidence,
        mappings,
        extra={
            "document_round_trip": True,
            "import_revision": next_revision,
            "history_export_reads": proof,
        },
    )
