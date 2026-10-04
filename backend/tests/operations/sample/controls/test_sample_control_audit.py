"""Owned Audit review and complete server CSV export use Manage's contracts."""

import csv
import io
import json
from datetime import date
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleClient
from operations.sample.controls.actions import execute_control_action
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext, SamplePhaseActionError
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import read_route_evidence

HEADERS = ["Date", "User", "Entity", "Action", "Target", "Before", "After"]


def _execute(tmp_path: Path, *, operation="audit_review", pack_key="harbor", fault=None):
    dataset = build_dataset("small", 83, date(2026, 10, 2), organization=get_pack(pack_key))
    module = dataset.organization.catalog.modules[0]
    actor_id, module_id = str(uuid4()), str(uuid4())
    rows = [
        {
            "id": str(uuid4()),
            "created_at": f"2026-10-02T10:00:{59 - index:02d}Z",
            "performed_by": actor_id,
            "action": "create",
            "entity_type": "modules",
            "entity_id": module_id,
            "department_id": None,
            "before": None,
            "after": {"module_name": module.name, "title_field_id": str(uuid4())},
            "request_id": str(uuid4()),
            "request_method": "POST",
            "request_path": "/api/sandbox/publications",
            "actor_label": "Sample Administrator",
            "actor_name": "  Sample Administrator  "
            if fault == "actor_padding"
            else "=Sample Administrator"
            if fault == "actor_formula"
            else "Sample Administrator",
            "note": None,
            "target_label": module.name,
        }
        for index in range(12)
    ]
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(200, headers={"Set-Cookie": "openslate_csrf=fixture; Path=/"})
        assert request.method == "GET"
        seen.append(request)
        if request.url.path == "/api/audit-logs":
            limit = int(request.url.params["limit"])
            items = [dict(row) for row in rows[:limit]]
            if fault == "preview_page":
                items.pop()
            if fault == "list_label":
                items[0]["target_label"] = module_id
            if fault == "list_identity":
                items[0]["entity_id"] = str(uuid4())
            total = 10_001 if fault == "over_cap" else len(rows)
            return httpx.Response(
                200,
                json={
                    "items": items,
                    "pagination": {
                        "limit": limit,
                        "offset": 0,
                        "count": len(items),
                        "total": total,
                        "has_more": len(items) < total,
                    },
                },
            )
        if request.url.path == "/api/audit-logs/export":
            if fault == "server_failure":
                return httpx.Response(503, json={"detail": "Audit export unavailable"})
            stream = io.StringIO(newline="")
            writer = csv.writer(stream, quoting=csv.QUOTE_ALL, lineterminator="\r\n")
            writer.writerow(HEADERS if fault != "columns" else HEADERS[:-1])
            for index, row in enumerate(rows[:-1] if fault == "truncated" else rows):
                writer.writerow(
                    [
                        "invalid-date"
                        if fault == "tail_date" and index == len(rows) - 1
                        else "2026-10-01T10:00:00+00:00"
                        if fault == "csv_date"
                        else row["created_at"],
                        ("'" if row["actor_name"].strip().startswith("=") else "")
                        + (row["actor_name"].strip() or "Unknown person"),
                        "Modules",
                        "Create",
                        module_id if fault == "csv_label" else row["target_label"],
                        "No previous values recorded.",
                        "No updated values recorded."
                        if fault == "csv_snapshot"
                        else (
                            f"Module Name: {module.name}\n"
                            f"Title Field Id: {row['after']['title_field_id']}"
                        ),
                    ]
                )
            body = stream.getvalue().removesuffix("\r\n")
            if fault == "malformed":
                body = body.rstrip() + '\r\n"unterminated'
            headers = {
                "Content-Type": "application/json" if fault == "mime" else "text/csv;charset=utf-8",
                "Content-Disposition": 'attachment; filename="openslate-audit.csv"',
                "Cache-Control": "no-store",
                "X-Audit-Export-Count": "11" if fault == "count" else str(len(rows)),
            }
            if fault == "disposition":
                headers.pop("Content-Disposition")
            if fault == "cache":
                headers.pop("Cache-Control")
            if fault == "count_format":
                headers["X-Audit-Export-Count"] = "+12"
            return httpx.Response(200, content=body.encode(), headers=headers)
        if request.url.path.endswith("/options"):
            return httpx.Response(200, json={"entity_types": ["modules"], "actors": []})
        assert request.url.path == f"/api/audit-logs/{rows[0]['id']}"
        detail = dict(rows[0])
        if fault == "detail_label":
            detail.pop("target_label")
        return httpx.Response(200, json=detail)

    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        client.login("operator@example.test", "fixture-memory-only")
        context = PhaseExecutionContext(
            clients={"admin": client},
            user_ids={"admin": actor_id},
            group_ids={},
            department_ids={},
            module_ids={module.key: module_id},
            field_ids={},
            mappings={},
            admin_password="fixture-memory-only",
        )
        action = PhaseAction(
            key=f"control:{operation}",
            phase="reorganization",
            kind="audit_controls",
            actor_key="admin",
            target_key=module.key,
            values={"operation": operation, "expected_label": module.name},
            expected_status=200,
            expected_detail=None,
            expected_end_state={
                "reviewed" if operation == "audit_review" else "exported": True,
                "target_label": module.name,
                "read_checks": 3 if operation == "audit_review" else 2,
            },
        )
        result = execute_control_action(action, dataset, context)
    return result, seen, module, rows


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_audit_review_lists_entries_then_reads_options_and_a_real_detail(
    tmp_path: Path, pack_key: str
) -> None:
    result, seen, module, rows = _execute(tmp_path, pack_key=pack_key)
    assert result["target_label"] == module.name
    assert result["audit_id"] == rows[0]["id"]
    assert result["reviewed"] is True and result["read_checks"] == 3
    assert [request.url.path for request in seen] == [
        "/api/audit-logs",
        "/api/audit-logs/options",
        f"/api/audit-logs/{rows[0]['id']}",
    ]
    params = dict(seen[0].url.params)
    assert params == {
        "limit": "25",
        "offset": "0",
        "sort_by": "created_at",
        "sort_order": "desc",
        "entity_type": "modules",
        "search": module.name,
    }


@pytest.mark.parametrize("fault", ("list_label", "list_identity", "detail_label"))
def test_audit_review_stops_on_unproven_owned_target_label(tmp_path: Path, fault: str) -> None:
    with pytest.raises(SamplePhaseActionError):
        _execute(tmp_path, fault=fault)


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_audit_export_downloads_complete_csv_for_the_pinned_owned_module(
    tmp_path: Path, pack_key: str
) -> None:
    result, seen, module, _rows = _execute(tmp_path, operation="audit_export", pack_key=pack_key)
    assert result["exported"] is True and result["row_count"] == 12
    assert result["target_label"] == module.name and result["read_checks"] == 2
    assert result["request_evidence"] == []
    preview, export = seen
    preview_params, export_params = dict(preview.url.params), dict(export.url.params)
    assert preview.url.path == "/api/audit-logs" and export.url.path == "/api/audit-logs/export"
    assert preview_params.pop("limit") == "10" and preview_params.pop("offset") == "0"
    assert preview_params == export_params
    assert export_params.pop("created_before")
    assert export_params == {
        "entity_type": "modules",
        "search": module.name,
        "sort_by": "created_at",
        "sort_order": "desc",
    }
    evidence = read_route_evidence(tmp_path / "requests.jsonl")
    assert {"method": "GET", "path": "/api/audit-logs/export", "requests": 1} in evidence["covered"]


@pytest.mark.parametrize("fault", ("actor_padding", "actor_formula"))
def test_audit_export_accepts_the_servers_formatted_actor_name(tmp_path: Path, fault: str) -> None:
    result, _seen, _module, _rows = _execute(tmp_path, operation="audit_export", fault=fault)
    assert result["exported"] is True and result["row_count"] == 12


@pytest.mark.parametrize(
    "fault",
    (
        "mime",
        "disposition",
        "cache",
        "columns",
        "malformed",
        "truncated",
        "count",
        "count_format",
        "csv_label",
        "csv_date",
        "csv_snapshot",
        "tail_date",
        "preview_page",
        "over_cap",
    ),
)
def test_audit_export_stops_on_invalid_or_incomplete_download(tmp_path: Path, fault: str) -> None:
    with pytest.raises(SamplePhaseActionError):
        _execute(tmp_path, operation="audit_export", fault=fault)
    if fault == "over_cap":
        started = [
            json.loads(line) for line in (tmp_path / "requests.jsonl").read_text().splitlines()
        ]
        assert not any(row.get("route_template") == "/api/audit-logs/export" for row in started)


def test_audit_export_preserves_server_failure_in_the_request_journal(tmp_path: Path) -> None:
    with pytest.raises(SamplePhaseActionError) as error:
        _execute(tmp_path, operation="audit_export", fault="server_failure")
    assert error.value.status_code == 503
    assert read_route_evidence(tmp_path / "requests.jsonl")["failures_5xx"] == {"other": 1}
