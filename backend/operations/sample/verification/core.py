"""Read-only API verification primitives for the sample-data operator."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import Any
from uuid import UUID

from operations.sample.blueprint import SampleDataset, SampleEdge, SampleRecord
from operations.sample.client import SampleClient
from operations.sample.verification.named_scenarios import named_scenario_issues


class SampleVerificationError(RuntimeError):
    """A sample baseline or readback does not match its expected state."""


def has_matching_audit(
    rows: Sequence[Mapping[str, Any]],
    *,
    entity_id: str,
    actor_id: str,
    methods: set[str],
    path_prefix: str,
    action: str = "create",
) -> bool:
    """Require an entity, actor, action, method, route and UUID request context."""
    for row in rows:
        request_id = row.get("request_id")
        try:
            UUID(str(request_id))
        except (AttributeError, TypeError, ValueError):
            continue
        path = row.get("request_path")
        if not isinstance(path, str):
            continue
        if (
            str(row.get("entity_id")) == entity_id
            and str(row.get("performed_by")) == actor_id
            and row.get("action") == action
            and row.get("request_method") in methods
            and (path == path_prefix or path.startswith(path_prefix.rstrip("/") + "/"))
        ):
            return True
    return False


def assert_pristine_baseline(client: SampleClient, *, operator_id: str) -> dict[str, Any]:
    """The operator's new organization holds only the operator, before its administrator."""
    workspace = _api_object(client, "/api/workspace")
    assert_pristine_workspace(workspace)
    sandbox = _api_object(client, "/api/sandbox/document")
    assert_pristine_sandbox(sandbox)

    users = list_all_rows(client, "/api/users")
    if (
        len(users) != 1
        or str(users[0].get("id")) != operator_id
        or users[0].get("role") != "admin"
        or users[0].get("status") != "active"
        or users[0].get("is_deleted") is not False
    ):
        raise SampleVerificationError("The baseline must contain only the active operator")

    for path, page_size in (
        ("/api/access/groups", 100),
        ("/api/departments", 100),
        ("/api/modules", 100),
        ("/api/fields", 100),
        ("/api/records", 100),
        ("/api/relationships", 100),
        ("/api/sandbox/versions", 100),
        ("/api/sandbox/tests", 100),
        ("/api/sandbox/trigger-runs", 50),
    ):
        if list_all_rows(client, path, page_size=page_size):
            raise SampleVerificationError(f"The baseline already contains data in {path}")

    boards = list_all_rows(client, "/api/boards")
    if (
        len(boards) != 1
        or boards[0].get("scope") != "company"
        or boards[0].get("name") != "Company Board"
        or boards[0].get("status") != "active"
    ):
        raise SampleVerificationError("The baseline must contain only the built-in Company Board")
    return {"workspace": workspace, "boards": boards, "admin": users[0]}


def expected_record_actor(record: SampleRecord | None, actor_ids: Mapping[str, str]) -> str:
    """The user who must appear on a record's create audit: its planned creator."""
    return actor_ids.get(record.creator_key, "") if record else ""


def expected_edge_actor(
    target: SampleRecord | None, actor_ids: Mapping[str, str], *, edge: SampleEdge | None = None
) -> str:
    """The planned link writer, with the child creator retained for legacy edges."""
    if edge is not None and edge.creator_key:
        return actor_ids.get(edge.creator_key, "")
    return actor_ids.get(target.creator_key, "") if target else ""


def verify_records_and_relationships(
    client: SampleClient,
    *,
    dataset: SampleDataset,
    mappings: Mapping[str, Mapping[str, str]],
    actor_ids: Mapping[str, str],
    started_at: str,
    finished_at: str,
    require_complete: bool,
) -> tuple[dict[str, int], list[str]]:
    """Read every seeded record/link and its matching authenticated audit evidence."""
    module_ids = mappings.get("modules", {})
    record_ids = mappings.get("records", {})
    field_ids = mappings.get("fields", {})
    relation_fields = mappings.get("relationships", {})
    issues: list[str] = []
    observed: dict[str, int] = {}
    records_by_id: dict[str, Mapping[str, Any]] = {}
    logical_by_id = {server_id: logical for logical, server_id in record_ids.items()}
    expected_records = {record.logical_id: record for record in dataset.records}
    if len(logical_by_id) != len(record_ids):
        issues.append("multiple logical records map to the same server ID")
    if require_complete and set(record_ids) != set(expected_records):
        issues.append("record ID journal does not cover the generated dataset")

    for module_key, expected_count in dataset.module_counts.items():
        module_id = module_ids.get(module_key)
        if not module_id:
            issues.append(f"module ID mapping is missing for {module_key}")
            observed[module_key] = 0
            continue
        rows = list_all_rows(client, "/api/records", params={"module_id": module_id})
        observed[module_key] = len(rows)
        if len(rows) != expected_count:
            issues.append(f"{module_key} record count differs from the generated profile")
        for row in rows:
            server_id = _string(row.get("id"), "record ID")
            records_by_id[server_id] = row
            logical_id = logical_by_id.get(server_id)
            if logical_id is None:
                issues.append(f"{module_key} contains an unjournaled record")
                continue
            generated = expected_records.get(logical_id)
            if generated is None or generated.module_key != module_key:
                issues.append(f"{module_key} record mapping points to another module")
                continue
            if str(row.get("module_id")) != module_id:
                issues.append(f"{logical_id} is stored in the wrong module")
            name_field_id = field_ids.get(f"{module_key}:name")
            name_doc_id = dataset.field_ids[module_key].get("name")
            expected_name = generated.data.get(name_doc_id) if name_doc_id else None
            data = row.get("data")
            if (
                not isinstance(data, dict)
                or not name_field_id
                or data.get(name_field_id) != expected_name
            ):
                issues.append(f"{logical_id} does not contain its generated record name")
    observed["records"] = sum(observed.get(key, 0) for key in dataset.module_counts)
    observed["record_mappings"] = len(record_ids)

    expected_edges: set[tuple[str, str, str]] = set()
    planned_edges: dict[tuple[str, str, str], SampleEdge] = {}
    relation_key_by_document_id = {
        document_id: key for key, document_id in dataset.relationship_ids.items()
    }
    for sample_edge in dataset.edges:
        relation_key = relation_key_by_document_id.get(sample_edge.relationship_id)
        field_id = relation_fields.get(relation_key or "")
        source_id = record_ids.get(sample_edge.source_record_id)
        target_id = record_ids.get(sample_edge.target_record_id)
        if field_id is None or source_id is None or target_id is None:
            issues.append("relationship field or record ID mapping is incomplete")
            continue
        expected_edges.add((field_id, source_id, target_id))
        planned_edges[(field_id, source_id, target_id)] = sample_edge

    edge_rows = list_all_rows(client, "/api/relationships", page_size=100)
    observed["relationships"] = len(edge_rows)
    actual_edges: set[tuple[str, str, str]] = set()
    edge_ids: dict[tuple[str, str, str], str] = {}
    for row in edge_rows:
        edge_key = (
            _string(row.get("field_id"), "relationship field ID"),
            _string(row.get("source_record_id"), "relationship source ID"),
            _string(row.get("target_record_id"), "relationship target ID"),
        )
        actual_edges.add(edge_key)
        edge_id = _string(row.get("id"), "relationship ID")
        edge_ids[edge_key] = edge_id
    if actual_edges != expected_edges or len(edge_rows) != len(actual_edges):
        issues.append("relationship graph differs from the generated edges")
    if require_complete and len(edge_rows) != len(dataset.edges):
        issues.append("relationship count differs from the generated profile")

    record_audits = list_all_rows(
        client,
        "/api/audit-logs",
        params={
            "entity_type": "records",
            "created_after": started_at,
            "created_before": finished_at,
        },
    )
    observed["record_audit_rows"] = len(record_audits)
    record_audits_by_entity: dict[str, list[Mapping[str, Any]]] = {}
    for audit in record_audits:
        entity_id = audit.get("entity_id")
        if isinstance(entity_id, str):
            record_audits_by_entity.setdefault(entity_id, []).append(audit)
    record_audit_matches = 0
    for server_id in records_by_id:
        generated = expected_records.get(logical_by_id.get(server_id, ""))
        expected_actor = expected_record_actor(generated, actor_ids)
        matches = record_audits_by_entity.get(server_id, [])
        if has_matching_audit(
            matches,
            entity_id=server_id,
            actor_id=expected_actor,
            methods={"POST"},
            path_prefix="/api/records",
        ):
            record_audit_matches += 1
        else:
            issues.append("a record is missing matching authenticated create audit evidence")
    observed["record_audit_matches"] = record_audit_matches

    relationship_audits = list_all_rows(
        client,
        "/api/audit-logs",
        params={
            "entity_type": "relationship_edges",
            "created_after": started_at,
            "created_before": finished_at,
        },
    )
    observed["relationship_audit_rows"] = len(relationship_audits)
    relation_audits_by_entity: dict[str, list[Mapping[str, Any]]] = {}
    for audit in relationship_audits:
        entity_id = audit.get("entity_id")
        if isinstance(entity_id, str):
            relation_audits_by_entity.setdefault(entity_id, []).append(audit)
    relationship_audit_matches = 0
    for edge_key, edge_id in edge_ids.items():
        target = expected_records.get(logical_by_id.get(edge_key[2]) or "")
        expected_actor = expected_edge_actor(target, actor_ids, edge=planned_edges.get(edge_key))
        matches = relation_audits_by_entity.get(edge_id, [])
        if has_matching_audit(
            matches,
            entity_id=edge_id,
            actor_id=expected_actor,
            methods={"POST", "PUT"},
            path_prefix="/api/relationships",
        ):
            relationship_audit_matches += 1
        else:
            issues.append("a relationship is missing matching authenticated create audit evidence")
    observed["relationship_audit_matches"] = relationship_audit_matches

    named_scenario_findings = named_scenario_issues(
        dataset,
        records_by_id,
        record_ids,
        field_ids,
        relation_fields,
        actual_edges,
    )
    issues.extend(named_scenario_findings)
    observed["named_scenario_verified"] = int(not named_scenario_findings)
    return observed, issues


def assert_pristine_workspace(workspace: Mapping[str, Any]) -> None:
    expected: dict[str, object] = {
        "display_name": "OpenSlate",
        "legal_name": None,
        "description": None,
        "contact_email": None,
        "contact_phone": None,
        "postal_address": None,
        "logo_file_id": None,
        "timezone": "UTC",
        "locale": "en-US",
        "invitation_expiry_days": 7,
        "guest_duration_days": 30,
        "revision": 1,
    }
    if any(workspace.get(key) != value for key, value in expected.items()):
        raise SampleVerificationError("The workspace is not at its fresh-install defaults")


def assert_pristine_sandbox(document_response: Mapping[str, Any]) -> None:
    expected: dict[str, object] = {
        "kind": "openslate-sandbox",
        "schemaVersion": 4,
        "design": {"departments": [], "modules": [], "relationships": [], "layout": {}},
        "triggers": [],
        "scenarios": [],
    }
    if document_response.get("revision") != 1 or document_response.get("document") != expected:
        raise SampleVerificationError("The Sandbox document has already been edited")


def unique_rows_by_name(
    rows: Sequence[Mapping[str, Any]], *, name_key: str, entity: str
) -> dict[str, Mapping[str, Any]]:
    indexed: dict[str, Mapping[str, Any]] = {}
    for row in rows:
        name = row.get(name_key)
        if not isinstance(name, str) or not name.strip():
            raise SampleVerificationError(f"A {entity} name is missing")
        key = name.strip().casefold()
        if key in indexed:
            raise SampleVerificationError(f"The {entity} name mapping is ambiguous")
        indexed[key] = row
    return indexed


def count_mismatches(
    expected: Mapping[str, int], observed: Mapping[str, int]
) -> dict[str, dict[str, int]]:
    return {
        name: {"expected": expected.get(name, 0), "observed": observed.get(name, 0)}
        for name in sorted(set(expected) | set(observed))
        if expected.get(name, 0) != observed.get(name, 0)
    }


def failure_report(
    stage: str,
    error: BaseException,
    *,
    step: str | None = None,
) -> dict[str, str]:
    from operations.sample.failures import safe_operator_message, safe_request_metadata

    report = {
        "status": "incomplete",
        "stage": stage,
        "step": step or stage,
        "error_type": type(error).__name__,
        "message": safe_operator_message(error)
        or "The operation stopped; reconcile server state before rebuilding.",
    }
    report.update(safe_request_metadata(error))
    return report


def _api_object(client: SampleClient, path: str) -> dict[str, Any]:
    response = client.request("GET", path)
    if response.status_code != 200:
        raise SampleVerificationError(f"GET {path} returned HTTP {response.status_code}")
    try:
        payload = response.json()
    except (json.JSONDecodeError, ValueError):
        raise SampleVerificationError(f"GET {path} returned invalid JSON") from None
    if not isinstance(payload, dict):
        raise SampleVerificationError(f"GET {path} returned an invalid object")
    return payload


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise SampleVerificationError(f"API {label} is missing")
    return value


def list_all_rows(
    client: SampleClient,
    path: str,
    *,
    page_size: int = 100,
    params: Mapping[str, Any] | None = None,
) -> list[Mapping[str, Any]]:
    if not 1 <= page_size <= 100:
        raise ValueError("Sample verification page size must be between 1 and 100")
    base_params = dict(params or {})
    output: list[Mapping[str, Any]] = []
    expected_total: int | None = None
    offset = 0
    while expected_total is None or offset < expected_total:
        response = client.request(
            "GET",
            path,
            params={**base_params, "limit": page_size, "offset": offset},
        )
        if response.status_code != 200:
            raise SampleVerificationError(f"GET {path} returned HTTP {response.status_code}")
        try:
            payload = response.json()
        except (json.JSONDecodeError, ValueError):
            raise SampleVerificationError(f"GET {path} returned invalid JSON") from None
        if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
            raise SampleVerificationError(f"GET {path} returned an invalid list response")
        pagination = payload.get("pagination")
        if isinstance(pagination, dict):
            total = pagination.get("total")
            limit = pagination.get("limit")
            reported_offset = pagination.get("offset")
            count = pagination.get("count")
            has_more = pagination.get("has_more")
        else:
            total = payload.get("total")
            limit = payload.get("limit")
            reported_offset = payload.get("offset")
            count = payload.get("count")
            has_more = payload.get("hasMore", payload.get("has_more"))
        if not isinstance(total, int) or isinstance(total, bool) or total < 0:
            raise SampleVerificationError(f"GET {path} returned an invalid total")
        rows = payload["items"]
        if (
            limit != page_size
            or reported_offset != offset
            or count != len(rows)
            or not isinstance(has_more, bool)
            or has_more != (offset + len(rows) < total)
        ):
            raise SampleVerificationError(f"GET {path} returned inconsistent pagination metadata")
        if expected_total is None:
            expected_total = total
        elif total != expected_total:
            raise SampleVerificationError(f"GET {path} changed while pages were being read")
        if len(rows) > page_size or any(not isinstance(row, dict) for row in rows):
            raise SampleVerificationError(f"GET {path} returned an invalid page")
        if offset < expected_total and not rows:
            raise SampleVerificationError(f"GET {path} ended before its reported total")
        output.extend(rows)
        offset += len(rows)
    if len(output) != expected_total:
        raise SampleVerificationError(f"GET {path} did not return its reported total")
    return output
