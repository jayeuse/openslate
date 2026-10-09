"""Final owned-version receipt and API end-state reconciliation."""

import json
from collections.abc import Mapping
from typing import Any
from uuid import UUID

from app.systems.sandbox.designs.schemas import VersionDetailResponse, VersionResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.version_prune import plan_version_prune
from operations.sample.phases.expectations import read_phase_plan
from operations.sample.verification.core import SampleVerificationError


def _uuid(value: object) -> str:
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError("Invalid version-prune identifier")
    return value


def _version(value: dict[str, Any]) -> dict[str, Any]:
    """Validate the complete public metadata DTO, including JSON UUID/date semantics."""
    _uuid(value.get("id"))
    return VersionResponse.model_validate_json(json.dumps(value), strict=True).model_dump(
        mode="json", by_alias=True
    )


def _page(admin: SampleClient) -> list[dict[str, Any]]:
    response = admin.request("GET", "/api/sandbox/versions", params={"limit": 100, "offset": 0})
    body = response.json()
    if response.status_code != 200 or not isinstance(body, dict):
        raise ValueError("Prune readback failed")
    items = body.get("items")
    metadata = body
    if (
        not isinstance(metadata, dict)
        or not isinstance(items, list)
        or any(not isinstance(row, dict) for row in items)
        or any(type(metadata.get(key)) is not int for key in ("limit", "offset", "count", "total"))
        or metadata["limit"] != 100
        or metadata["offset"] != 0
        or metadata["count"] != len(items)
        or metadata["total"] != len(items)
        or len(items) > 100
        or metadata.get("hasMore") is not False
    ):
        raise ValueError("Prune readback page is incomplete")
    identifiers = [_uuid(row.get("id")) for row in items]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError("Prune readback IDs repeat")
    if (
        type(body.get("mutableCount")) is not int
        or type(body.get("versionCap")) is not int
        or body["versionCap"] != 50
        or any(row.get("kind") not in {"checkpoint", "imported", "published"} for row in items)
        or body["mutableCount"] != sum(row["kind"] != "published" for row in items)
        or any(row.get("isDeleted") is not False for row in items)
    ):
        raise ValueError("Prune readback capacity or kind is invalid")
    return [_version(row) for row in items]


def _receipt(
    receipt: Mapping[str, Any],
    *,
    step: str,
    method: str,
    path: str,
    status: int,
    action: str,
    expected: list[dict[str, Any]],
    admin_id: str,
    request_ids: set[str],
) -> None:
    request_id = _uuid(receipt.get("request_id"))
    if (
        request_id in request_ids
        or receipt.get("step") != step
        or receipt.get("actor_key") != "admin"
        or receipt.get("actor_id") != admin_id
        or receipt.get("method") != method
        or receipt.get("path") != path
        or type(receipt.get("status_code")) is not int
        or receipt["status_code"] != status
        or type(receipt.get("expected_status")) is not int
        or receipt["expected_status"] != status
        or receipt.get("primary_entity_type") != "sandbox_versions"
        or receipt.get("primary_action") != action
        or receipt.get("primary_entity_id") != (expected[0]["id"] if len(expected) == 1 else None)
        or receipt.get("related_entity_types") != ["sandbox_documents"]
    ):
        raise ValueError("Prune receipt differs from its owned mutation")
    request_ids.add(request_id)


def _proof(
    admin: SampleClient, dataset: SampleDataset, manifest: Mapping[str, Any], admin_id: str
) -> None:
    _uuid(admin_id)
    actions = read_phase_plan({"phase_plan": manifest.get("control_plan")})
    selected = [action for action in actions if action.values.get("operation") == "prune_versions"]
    if selected != list(plan_version_prune(dataset)) or len(selected) != 1:
        raise ValueError("Prune plan differs from its required operation")
    raw = manifest.get("control_results")
    if not isinstance(raw, list) or any(not isinstance(row, Mapping) for row in raw):
        raise ValueError("Prune results are missing")
    results = [row for row in raw if row.get("action_key") == selected[0].key]
    if len(results) != 1:
        raise ValueError("Prune result is missing or repeated")
    result, action = results[0], selected[0]
    if (
        result.get("outcome") != "completed"
        or result.get("actor_key") != "admin"
        or result.get("actor_id") != admin_id
        or result.get("target_key") != action.target_key
        or any(
            type(result.get(key)) is not type(value) or result.get(key) != value
            for key, value in action.expected_end_state.items()
        )
    ):
        raise ValueError("Prune result differs from its actor or planned outcome")
    owned, protected, receipts = (
        result.get(key) for key in ("owned_versions", "protected_versions", "request_evidence")
    )
    if (
        not isinstance(owned, list)
        or len(owned) != 49
        or not isinstance(protected, list)
        or len(protected) != 2
        or not isinstance(receipts, list)
        or len(receipts) != 89
        or any(not isinstance(row, dict) for row in owned + protected + receipts)
    ):
        raise ValueError("Prune identity or receipt list is incomplete")
    owned = [_version(row) for row in owned]
    protected = [_version(row) for row in protected]
    ids = [_uuid(row.get("id")) for row in owned]
    if (
        len(set(ids)) != 49
        or result.get("pruned_ids") != ids[:10]
        or result.get("cleanup_ids") != ids[10:]
    ):
        raise ValueError("Prune candidate and cleanup identities differ")
    sequences = [row.get("sequence") for row in owned]
    if (
        any(type(value) is not int or value < 1 for value in sequences)
        or sequences != sorted(set(sequences))
        or any(
            row.get("kind") != "checkpoint"
            or row.get("performedBy") != admin_id
            or row.get("contentHash") != result.get("content_hash")
            for row in owned
        )
    ):
        raise ValueError("Prune checkpoints differ from their original snapshots")
    mappings = manifest.get("mappings")
    expected_mappings = {f"checkpoint_{index:02}": value for index, value in enumerate(ids)}
    receipt_mappings = [
        {"kind": "sandbox_prune_versions", "logical_id": key, "server_id": value}
        for key, value in expected_mappings.items()
    ]
    if (
        not isinstance(mappings, Mapping)
        or mappings.get("sandbox_prune_versions") != expected_mappings
        or result.get("mappings") != receipt_mappings
    ):
        raise ValueError("Prune mappings differ from their creation receipts")
    authored = mappings.get("sandbox_versions")
    if not isinstance(authored, Mapping):
        raise ValueError("Prune authored version mappings are missing")
    protected_ids = {_uuid(row.get("id")) for row in protected}
    if (
        protected_ids != {authored.get("initial_checkpoint"), authored.get("published")}
        or len(protected_ids) != 2
        or protected_ids & set(ids)
        or {row.get("kind") for row in protected} != {"checkpoint", "published"}
    ):
        raise ValueError("Prune protected authored versions differ")
    source_revisions = [row["sourceDocumentRevision"] for row in owned]
    first_revision = source_revisions[0]
    checkpoint = next(row for row in protected if row["id"] == authored["initial_checkpoint"])
    publication = next(row for row in protected if row["id"] == authored["published"])
    prune_revision = publication["sourceDocumentRevision"]
    if (
        first_revision < 1
        or source_revisions != list(range(first_revision, first_revision + 49))
        or checkpoint["sourceDocumentRevision"] != first_revision + 49
        or prune_revision != checkpoint["sourceDocumentRevision"] + 1
    ):
        raise ValueError("Prune retained source revisions do not cover its mutation sequence")
    rows = _page(admin)
    by_id = {row["id"]: row for row in rows}
    if set(ids) & set(by_id):
        raise ValueError("Owned prune versions remain active")
    for version in protected:
        row = by_id.get(version["id"])
        detail = admin.request("GET", f"/api/sandbox/versions/{version['id']}")
        body = VersionDetailResponse.model_validate_json(detail.content, strict=True).model_dump(
            mode="json", by_alias=True
        )
        if (
            row is None
            or detail.status_code != 200
            or not isinstance(body, dict)
            or any(
                row.get(key) != version.get(key) or body.get(key) != version.get(key)
                for key in (
                    "id",
                    "sequence",
                    "kind",
                    "label",
                    "contentHash",
                    "performedBy",
                    "sourceDocumentRevision",
                )
            )
        ):
            raise ValueError("Prune changed an authored version")
    for identifier in ids:
        if admin.request("GET", f"/api/sandbox/versions/{identifier}").status_code != 404:
            raise ValueError("Owned prune version detail remains available")
    contracts = [
        (
            f"prepare_checkpoint:{index:02}",
            "POST",
            "/api/sandbox/versions",
            201,
            "create",
            [row],
        )
        for index, row in enumerate(owned)
    ]
    contracts.append(
        (
            "prune_versions",
            "POST",
            "/api/sandbox/versions/prune",
            200,
            "delete",
            owned[:10],
        )
    )
    contracts.extend(
        (
            f"cleanup_checkpoint:{index:02}",
            "DELETE",
            f"/api/sandbox/versions/{row['id']}",
            204,
            "delete",
            [row],
        )
        for index, row in enumerate(owned[10:], 10)
    )
    request_ids: set[str] = set()
    for receipt, contract in zip(receipts, contracts, strict=True):
        step, method, path, status, action_name, versions = contract
        _receipt(
            receipt,
            step=step,
            method=method,
            path=path,
            status=status,
            action=action_name,
            expected=versions,
            admin_id=admin_id,
            request_ids=request_ids,
        )


def verify_version_prune(
    admin: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    """Require complete receipts and independent API proof of removal and preservation."""
    empty = {
        "sandbox_prune_verified": 0,
        "sandbox_prune_versions_removed": 0,
    }
    try:
        _proof(admin, dataset, manifest, admin_id)
    except (SampleClientError, SampleVerificationError, KeyError, TypeError, ValueError):
        return empty, ["Owned Sandbox prune receipts or final readback did not reconcile"]
    return {
        "sandbox_prune_verified": 1,
        "sandbox_prune_versions_removed": 49,
    }, []
