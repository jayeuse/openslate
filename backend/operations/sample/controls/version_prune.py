"""Run-owned checkpoints around the ordinary initial design; no arbitrary history cleanup."""

import hashlib
import re
from collections.abc import Mapping
from typing import Any, cast
from uuid import UUID

from pydantic import ValidationError

from app.systems.sandbox.designs.schemas import VersionDetailResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _read_json,
    _record_mapping,
    _request,
    _result,
)

_FACETS = ("id", "sequence", "kind", "label", "contentHash", "performedBy")


def plan_version_prune(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    return (
        PhaseAction(
            key="controls:sandbox:prune_versions",
            phase="reorganization",
            kind="sandbox_controls",
            actor_key="admin",
            target_key="owned_version_capacity",
            values={"operation": "prune_versions"},
            expected_status=200,
            expected_detail=None,
            expected_end_state={
                "deleted_count": 10,
                "temporary_versions_removed": 49,
                "document_preserved": True,
                "published_preserved": True,
            },
        ),
    )


def _refuse(step: str) -> SamplePhaseActionError:
    return SamplePhaseActionError("Owned Sandbox version proof is incomplete or changed", step=step)


def _uuid(value: object, step: str) -> str:
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError
    except ValueError:
        raise _refuse(step) from None
    return value


def _document(client: SampleClient, step: str) -> dict[str, Any]:
    response = client.request("GET", "/api/sandbox/document")
    body = _read_json(response, step=step)
    if (
        response.status_code != 200
        or type(body.get("revision")) is not int
        or body["revision"] < 1
        or not isinstance(body.get("document"), dict)
        or not isinstance(body.get("contentHash"), str)
        or re.fullmatch(r"[a-f0-9]{64}", body["contentHash"]) is None
    ):
        raise _refuse(step)
    return body


def _same_document(client: SampleClient, revision: int, content_hash: str, step: str) -> None:
    body = _document(client, step)
    if body["revision"] != revision or body["contentHash"] != content_hash:
        raise _refuse(step)


def _export_hash(client: SampleClient, step: str) -> str:
    response = client.request("GET", "/api/sandbox/export", params={"includeVersions": "false"})
    if (
        response.status_code != 200
        or len(response.content) > 5 * 1024 * 1024
        or response.headers.get("Content-Type", "").split(";")[0] != "application/json"
    ):
        raise _refuse(step)
    return hashlib.sha256(response.content).hexdigest()


def _versions(client: SampleClient, step: str) -> list[dict[str, Any]]:
    response = client.request("GET", "/api/sandbox/versions", params={"limit": 100, "offset": 0})
    body = _read_json(response, step=step)
    items = body.get("items")
    if (
        response.status_code != 200
        or not isinstance(items, list)
        or any(not isinstance(row, dict) for row in items)
        or any(
            type(body.get(key)) is not int
            for key in ("limit", "offset", "count", "total", "mutableCount", "versionCap")
        )
        or body["limit"] != 100
        or body["offset"] != 0
        or body["count"] != len(items)
        or body["total"] != len(items)
        or len(items) > 100
        or body.get("hasMore") is not False
        or body["versionCap"] != 50
    ):
        raise _refuse(step)
    seen: set[str] = set()
    previous = None
    for row in items:
        identifier = _uuid(row.get("id"), step)
        sequence = row.get("sequence")
        if (
            identifier in seen
            or type(sequence) is not int
            or sequence < 1
            or (previous is not None and sequence >= previous)
            or row.get("kind") not in {"checkpoint", "imported", "published"}
            or row.get("isDeleted") is not False
            or row.get("deletedAt") is not None
            or not isinstance(row.get("label"), str)
            or not isinstance(row.get("contentHash"), str)
            or re.fullmatch(r"[a-f0-9]{64}", row["contentHash"]) is None
        ):
            raise _refuse(step)
        seen.add(identifier)
        previous = sequence
    if body["mutableCount"] != sum(row["kind"] != "published" for row in items):
        raise _refuse(step)
    return cast(list[dict[str, Any]], items)


def _same_versions(rows: list[dict[str, Any]], expected: list[dict[str, Any]], step: str) -> None:
    by_id = {row["id"]: row for row in rows}
    if set(by_id) != {row["id"] for row in expected}:
        raise _refuse(step)
    if any(any(by_id[row["id"]].get(key) != row.get(key) for key in _FACETS) for row in expected):
        raise _refuse(step)


def prepare_prune_fixture(
    admin: SampleClient,
    dataset: SampleDataset,
    *,
    actor_id: str,
    run_id: str,
    document_response: Mapping[str, Any],
) -> tuple[int, dict[str, Any] | None]:
    """Called only after the ordinary initial document PUT, before its authored checkpoint."""
    revision = document_response.get("revision")
    if type(revision) is not int or revision < 1:
        raise _refuse("prune_prepare_document")
    if not plan_version_prune(dataset):
        return revision, None
    _uuid(actor_id, "prune_prepare_actor")
    if re.fullmatch(r"[a-f0-9]{32}", run_id) is None:
        raise _refuse("prune_prepare_run")
    action = plan_version_prune(dataset)[0]
    context = PhaseExecutionContext(
        clients={"admin": admin},
        user_ids={"admin": actor_id},
        group_ids={},
        department_ids={},
        module_ids={},
        field_ids={},
        mappings={},
        admin_password="",
    )
    initial = _document(admin, "prune_prepare_document")
    content_hash = initial["contentHash"]
    if (
        initial["revision"] != revision
        or content_hash != document_response.get("contentHash")
        or _versions(admin, "prune_prepare_scan")
    ):
        raise _refuse("prune_prepare_scan")
    export_hash = _export_hash(admin, "prune_prepare_export")
    _same_document(admin, revision, content_hash, "prune_prepare_revision")
    evidence: list[dict[str, object]] = []
    mappings: list[dict[str, str]] = []
    versions: list[dict[str, Any]] = []
    for index in range(49):
        label = f"Sample prune {run_id[:12]} {index:02}"
        response = _request(
            action,
            context,
            evidence,
            actor_key="admin",
            method="POST",
            path="/api/sandbox/versions",
            step=f"prepare_checkpoint:{index:02}",
            expected=201,
            on_substep=None,
            json_body={"expectedRevision": revision, "kind": "checkpoint", "label": label},
            primary_entity_type="sandbox_versions",
            primary_action="create",
            expected_audit_rows=1,
            related_entity_types=("sandbox_documents",),
        )
        body = _read_json(response, step="prune_prepare_checkpoint")
        try:
            metadata = VersionDetailResponse.model_validate_json(response.content, strict=True)
        except ValidationError:
            raise _refuse("prune_prepare_checkpoint") from None
        identifier = _uuid(body.get("id"), "prune_prepare_checkpoint")
        if (
            identifier in {row["id"] for row in versions}
            or body.get("kind") != "checkpoint"
            or body.get("label") != label
            or body.get("performedBy") != actor_id
            or body.get("contentHash") != content_hash
            or type(body.get("sequence")) is not int
            or body["sequence"] < 1
            or (versions and body["sequence"] <= versions[-1]["sequence"])
            or body.get("sourceDocumentRevision") != revision
            or body.get("document") != initial["document"]
        ):
            raise _refuse("prune_prepare_checkpoint")
        evidence[-1]["primary_entity_id"] = identifier
        versions.append(metadata.model_dump(mode="json", by_alias=True, exclude={"document"}))
        _record_mapping(
            context, admin, "sandbox_prune_versions", f"checkpoint_{index:02}", identifier, mappings
        )
        revision += 1
        _same_document(admin, revision, content_hash, "prune_prepare_revision")
    return revision, {
        "actor_id": actor_id,
        "run_id": run_id,
        "versions": versions,
        "revision": revision,
        "request_evidence": evidence,
        "mappings": mappings,
        "content_hash": content_hash,
        "export_hash": export_hash,
    }


def execute_version_prune(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    """Prune only after exact owned-history proof, then delete only the retained owned IDs."""
    if action not in plan_version_prune(dataset):
        raise _refuse(action.key)
    fixture = context.private_values.get("sandbox_prune_fixture")
    actor_id = context.user_ids.get("admin")
    if (
        not isinstance(fixture, dict)
        or fixture.get("actor_id") != actor_id
        or not isinstance(fixture.get("versions"), list)
        or len(fixture["versions"]) != 49
        or not isinstance(fixture.get("request_evidence"), list)
        or len(fixture["request_evidence"]) != 49
        or not isinstance(fixture.get("mappings"), list)
    ):
        raise _refuse("prune_fixture")
    client = context.clients["admin"]
    owned = cast(list[dict[str, Any]], fixture["versions"])
    content_hash, export_hash = fixture["content_hash"], fixture["export_hash"]
    if any(not isinstance(row, dict) for row in owned):
        raise _refuse("prune_fixture")
    mapped = context.runtime_mappings.get("sandbox_prune_versions", {})
    if mapped != {f"checkpoint_{index:02}": row["id"] for index, row in enumerate(owned)}:
        raise _refuse("prune_fixture")
    authored = context.runtime_mappings.get("sandbox_versions", {})
    authored_ids = [authored.get("initial_checkpoint"), authored.get("published")]
    if any(not isinstance(value, str) for value in authored_ids):
        raise _refuse("prune_fixture")
    before = _document(client, "prune_scan")
    revision = before["revision"]
    rows = _versions(client, "prune_scan")
    protected = [row for row in rows if row["id"] in authored_ids]
    _same_versions(rows, owned + protected, "prune_scan")
    if (
        len(rows) != 51
        or len(protected) != 2
        or type(fixture.get("revision")) is not int
        or revision != fixture["revision"] + 1
        or {row["kind"] for row in protected} != {"checkpoint", "published"}
        or before["contentHash"] != content_hash
        or any(
            row["contentHash"] != content_hash or row["performedBy"] != actor_id
            for row in protected
        )
        or min(row["sequence"] for row in protected) <= max(row["sequence"] for row in owned)
        or _export_hash(client, "prune_scan") != export_hash
    ):
        raise _refuse("prune_scan")
    _same_document(client, revision, content_hash, "prune_scan_revision")
    evidence = cast(list[dict[str, object]], list(fixture["request_evidence"]))
    mappings = cast(list[dict[str, str]], list(fixture["mappings"]))
    response = _request(
        action,
        context,
        evidence,
        actor_key="admin",
        method="POST",
        path="/api/sandbox/versions/prune",
        step="prune_versions",
        expected=200,
        on_substep=on_substep,
        json_body={"expectedRevision": revision},
        primary_entity_type="sandbox_versions",
        primary_action="delete",
        expected_audit_rows=10,
        related_entity_types=("sandbox_documents",),
    )
    body = _read_json(response, step="prune_result")
    if (
        set(body) != {"deletedCount"}
        or type(body["deletedCount"]) is not int
        or body["deletedCount"] != 10
    ):
        raise _refuse("prune_result")
    revision += 1
    _same_document(client, revision, content_hash, "prune_readback")
    remaining = owned[10:]
    _same_versions(_versions(client, "prune_readback"), remaining + protected, "prune_readback")
    for index, row in enumerate(remaining, 10):
        _same_document(client, revision, content_hash, "prune_cleanup_revision")
        _same_versions(
            _versions(client, "prune_cleanup_scan"), owned[index:] + protected, "prune_cleanup_scan"
        )
        detail = client.request("GET", f"/api/sandbox/versions/{row['id']}")
        current = _read_json(detail, step="prune_cleanup_identity")
        if detail.status_code != 200 or any(current.get(key) != row.get(key) for key in _FACETS):
            raise _refuse("prune_cleanup_identity")
        _same_document(client, revision, content_hash, "prune_cleanup_revision")
        _request(
            action,
            context,
            evidence,
            actor_key="admin",
            method="DELETE",
            path=f"/api/sandbox/versions/{row['id']}",
            step=f"cleanup_checkpoint:{index:02}",
            expected=204,
            on_substep=on_substep,
            json_body={"expectedRevision": revision},
            primary_entity_type="sandbox_versions",
            primary_entity_id=row["id"],
            primary_action="delete",
            expected_audit_rows=1,
            related_entity_types=("sandbox_documents",),
        )
        revision += 1
        _same_document(client, revision, content_hash, "prune_cleanup_revision")
    _same_versions(_versions(client, "prune_final_scan"), protected, "prune_final_scan")
    for row in owned:
        if client.request("GET", f"/api/sandbox/versions/{row['id']}").status_code != 404:
            raise _refuse("prune_final_missing")
    _same_document(client, revision, content_hash, "prune_final_revision")
    if _export_hash(client, "prune_final_export") != export_hash:
        raise _refuse("prune_final_export")
    return _result(
        action,
        context,
        evidence,
        mappings,
        extra={
            **action.expected_end_state,
            "owned_versions": owned,
            "protected_versions": protected,
            "pruned_ids": [row["id"] for row in owned[:10]],
            "cleanup_ids": [row["id"] for row in remaining],
            "content_hash": content_hash,
            "export_hash": export_hash,
        },
    )
