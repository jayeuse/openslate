"""Exact Chart request receipts, retained consumer provenance and fresh final state."""

import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from app.common.listing import PaginationMetadata
from app.systems.boards.portability_schemas import PortableBoardBundle
from app.systems.openview.charts.schemas import ChartResponse
from app.systems.openview.dashboards.schemas import DashboardResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.charts_consumers import _dashboard_specs
from operations.sample.controls.charts_receipts import _facts, _uuid
from operations.sample.packs.phase_types import PhaseAction


def verify_chart_export(
    dataset: SampleDataset, action: PhaseAction, chart: ChartResponse, bundle: PortableBoardBundle
) -> None:
    """Validate the control reference's lossless named instructions before import."""
    query = chart.query.model_dump(mode="json", exclude={"module_id"})
    module = next(
        row
        for row in dataset.organization.catalog.modules
        if row.key == action.values["module_key"]
    )
    title = next(row for row in module.fields if row.key == "name")
    query["dimension"] = {"name": title.name, "expected_type": query["dimension"]["expected_type"]}
    wanted = {
        "name": "Chart control reference",
        "widget_type": "chart",
        "source": {
            "department_name": dict(dataset.organization.catalog.departments)[module.department],
            "module_name": module.name,
        },
        "config": {
            "version": 1,
            "query": query,
            "size": "S",
            "pinned": True,
            "refresh": "manual",
            "chart_type": "bar",
        },
    }
    widgets = bundle.model_dump(mode="json")["configuration"]["widgets"]
    if not widgets or widgets[-1] != wanted:
        raise ValueError("Portable Chart semantics differ")


def verify_chart_list(
    created: ChartResponse, action: PhaseAction, receipts: Sequence[Mapping[str, Any]]
) -> tuple[int, bool]:
    """Validate the retained contiguous pages, including the full known created row."""
    pages = [row for row in receipts if row["step"].startswith("list_chart_")]
    if not 1 <= len(pages) <= 100:
        raise ValueError("Chart list proof is missing or exceeds its bound")
    offset, total, has_more = 0, None, True
    found: set[str] = set()
    for index, receipt in enumerate(pages):
        if (
            not has_more
            or receipt["step"] != f"list_chart_{index}"
            or receipt["request_body"] is not None
            or receipt["params"]
            != {
                "module_id": str(created.module_id),
                "department_id": str(created.department_id),
                "deleted": "include",
                "search": action.values["temporary_name"],
                "limit": 100,
                "offset": offset,
                "sort_by": "name",
                "sort_order": "asc",
            }
        ):
            raise ValueError("Chart list page sequence or parameters differ")
        body = receipt["response"]
        metadata = PaginationMetadata.model_validate_json(
            json.dumps(body["pagination"]), strict=True
        )
        rows = [
            ChartResponse.model_validate_json(json.dumps(row), strict=True) for row in body["items"]
        ]
        if (
            metadata.offset != offset
            or metadata.count != len(rows)
            or metadata.limit != 100
            or (total is not None and total != metadata.total)
            or any(
                row.module_id != created.module_id or row.department_id != created.department_id
                for row in rows
            )
        ):
            raise ValueError("Chart page ownership or counts differ")
        total = metadata.total
        for row in rows:
            identifier = str(row.id)
            if identifier in found or (row.id == created.id and row != created):
                raise ValueError("Chart list repeats an identity or changes its known state")
            found.add(identifier)
        offset += len(rows)
        has_more = metadata.has_more
        if (
            offset > total
            or has_more != (offset < total)
            or (has_more and not rows)
            or (not has_more and str(created.id) not in found)
        ):
            raise ValueError("Chart pages are incomplete or lack the created Chart")
    return offset, not has_more


def _write_contract(facts: Mapping[str, Any]) -> list[tuple[str, str, str, int, str]]:
    ids, actor = facts["ids"], facts["action"].actor_key
    root = f"/api/charts/{ids['chart_id']}"
    dashboard = f"/api/dashboards/{ids['dashboard_id']}"
    return [
        ("create_chart", "POST", "/api/charts", 201, actor),
        ("edit_chart", "PATCH", root, 200, actor),
        (
            "duplicate_board",
            "POST",
            f"/api/boards/{ids['source_board_id']}/duplicate",
            201,
            "admin",
        ),
        ("attach_board_chart", "POST", f"/api/boards/{ids['board_id']}/widgets", 201, "admin"),
        ("create_chart_dashboard", "POST", "/api/dashboards", 201, "admin"),
        ("attach_dashboard_chart", "PATCH", dashboard, 200, "admin"),
        ("archive_in_use_chart", "DELETE", root, 409, actor),
        ("import_board", "POST", "/api/boards/import", 201, "admin"),
        (
            "delete_board_chart",
            "DELETE",
            f"/api/boards/{ids['board_id']}/widgets/"
            + facts["single"]["attach_board_chart"]["response"]["widget"]["id"],
            204,
            "admin",
        ),
        ("clear_chart_dashboard", "PATCH", dashboard, 200, "admin"),
        ("archive_chart", "DELETE", root, 204, actor),
        ("restore_chart", "POST", root + "/restore", 200, actor),
        ("final_archive_chart", "DELETE", root, 204, actor),
        *[
            (step, "POST", f"/api/boards/{ids[key]}" + suffix, 200, "admin")
            for key in ("board_id", "import_id")
            for step, suffix in [
                ("archive_control_board", "/archive"),
                ("preview_control_board_purge", "/purge/preview"),
                ("purge_control_board", "/purge"),
            ]
        ],
        ("archive_chart_dashboard", "DELETE", dashboard, 204, "admin"),
    ]


def verify_chart_evidence(
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    action: PhaseAction,
    result: Mapping[str, Any],
    admin_id: str,
    seen_request_ids: set[str],
    observed: dict[str, int],
    issues: list[str],
) -> None:
    try:
        facts = _facts(dataset, manifest, admin_id, result)
        _consumer_state(facts)
        rows = result["request_evidence"]
        expected = _write_contract(facts)
        if len(rows) != len(expected):
            raise ValueError("Chart write sequence length differs")
        local = set()
        for row, (step, method, path, status, actor) in zip(rows, expected, strict=True):
            request_id = _uuid(row["request_id"])
            if (
                (
                    row["step"],
                    row["method"],
                    row["path"],
                    row["expected_status"],
                    row["status_code"],
                    row["actor_key"],
                    row["actor_id"],
                )
                != (step, method, path, status, status, actor, facts["actors"][actor])
                or request_id in seen_request_ids
                or request_id in local
            ):
                raise ValueError("Chart write attribution or request differs")
            receipt = next(
                (
                    item
                    for item in facts["receipts"]
                    if item["step"] == step and item["path"] == path
                ),
                None,
            )
            if receipt is not None and receipt["request_id"] != request_id:
                raise ValueError("Chart write/read receipt identity differs")
            if step in {
                "create_chart",
                "edit_chart",
                "archive_chart",
                "restore_chart",
                "final_archive_chart",
            }:
                entity, identifier, mutation = (
                    "charts",
                    facts["ids"]["chart_id"],
                    "create" if step == "create_chart" else "update",
                )
            elif step in {
                "create_chart_dashboard",
                "attach_dashboard_chart",
                "clear_chart_dashboard",
                "archive_chart_dashboard",
            }:
                entity, identifier, mutation = (
                    "dashboards",
                    facts["ids"]["dashboard_id"],
                    "create" if step == "create_chart_dashboard" else "update",
                )
            elif step in {"attach_board_chart", "delete_board_chart"}:
                entity, identifier, mutation = (
                    "board_widgets",
                    facts["single"]["attach_board_chart"]["response"]["widget"]["id"],
                    "create" if step == "attach_board_chart" else "delete",
                )
            elif step in {
                "duplicate_board",
                "import_board",
                "archive_control_board",
                "purge_control_board",
            }:
                entity, identifier, mutation = (
                    "boards",
                    (
                        facts["ids"]["board_id"]
                        if step == "duplicate_board"
                        else facts["ids"]["import_id"]
                        if step == "import_board"
                        else path.split("/")[3]
                    ),
                    "create"
                    if step in {"duplicate_board", "import_board"}
                    else "delete"
                    if step == "purge_control_board"
                    else "update",
                )
            else:
                entity, identifier, mutation = None, None, None
            if (
                row["primary_entity_type"],
                row["primary_entity_id"],
                row["primary_action"],
                row["expected_audit_rows"],
            ) != (entity, identifier, mutation, 1 if entity else 0):
                raise ValueError("Chart mutation/audit descriptor differs")
            local.add(request_id)
        blocked = next(row for row in facts["receipts"] if row["step"] == "archive_in_use_chart")
        if (
            blocked["params"] != {"revision": 2}
            or blocked["response"]["detail"]["code"] != "chart_in_use"
            or blocked["response"]["detail"]["usage"]
            != facts["single"]["usage_manager"]["response"]
        ):
            raise ValueError("Only named unchanged in-use Chart archive may return409")
        seen_request_ids.update(local)
        observed["control_requests_verified"] += len(rows)
    except (KeyError, TypeError, ValueError, ValidationError, IndexError):
        issues.append("Chart control request/ownership/readback evidence differs")


def _consumer_state(facts: Mapping[str, Any]) -> None:
    create = facts["single"]["create_chart_dashboard"]
    initial = DashboardResponse.model_validate_json(json.dumps(create["response"]), strict=True)
    body = create["request_body"]
    expected = {key: value for key, value in body.items() if key != "widgets"}
    # The copy joins a department whose sample Dashboard is already its home.
    expected.update(
        id=facts["ids"]["dashboard_id"], revision=1, is_home=False, is_deleted=False
    )
    if (
        initial.model_dump(mode="json", exclude={"created_at", "updated_at", "widgets"}) != expected
        or _dashboard_specs(initial) != body["widgets"]
    ):
        raise ValueError("Original created Dashboard metadata or sources differ")
    steps = [
        "create_chart_dashboard",
        "attach_dashboard_chart",
        "read_populated_dashboard",
        "usage_manager",
        "usage_admin",
        "clear_chart_dashboard",
    ]
    if [row["step"] for row in facts["receipts"] if row["step"] in steps] != steps:
        raise ValueError("Populated Dashboard read must follow append and precede usage/clear")
    metadata = initial.model_dump(mode="json", exclude={"widgets", "revision", "updated_at"})
    appended = facts["single"]["attach_dashboard_chart"]["response"]
    if facts["single"]["read_populated_dashboard"]["response"] != appended:
        raise ValueError("Populated Dashboard full current readback differs")
    for step, revision, specs in [
        (
            "attach_dashboard_chart",
            2,
            facts["single"]["attach_dashboard_chart"]["request_body"]["widgets"],
        ),
        ("read_cleared_dashboard", 3, []),
    ]:
        current = DashboardResponse.model_validate_json(
            json.dumps(facts["single"][step]["response"]), strict=True
        )
        if (
            current.model_dump(mode="json", exclude={"widgets", "revision", "updated_at"})
            != metadata
            or current.revision != revision
            or _dashboard_specs(current) != specs
            or any(row.position != index for index, row in enumerate(current.widgets))
        ):
            raise ValueError("Original append/clear Dashboard full state differs")


def verify_chart_controls(
    client: SampleClient, dataset: SampleDataset, manifest: Mapping[str, Any], admin_id: str
) -> tuple[dict[str, int], list[str]]:
    issues: list[str] = []
    try:
        facts = _facts(dataset, manifest, admin_id)
        verify_chart_evidence(
            dataset,
            manifest,
            facts["action"],
            facts["result"],
            admin_id,
            set(),
            {"control_requests_verified": 0},
            issues,
        )
        if issues:
            return {}, issues
        # Later controls (field close/reopen) may bump the source Board revision;
        # source preservation means unchanged content, not an unchanged revision.
        volatile = {
            "source_board": {"revision", "updated_at"},
            "source_widgets": {"board_revision"},
        }
        for path, step, wanted in [
            (f"/api/charts/{facts['ids']['chart_id']}", "chart", facts["chart"]),
            (f"/api/dashboards/{facts['ids']['dashboard_id']}", "dashboard", facts["dashboard"]),
            (
                f"/api/boards/{facts['ids']['source_board_id']}",
                "source_board",
                facts["source_board"],
            ),
            *[
                (f"/api/charts/{identifier}", "source_chart", source)
                for identifier, source in facts["source_charts"].items()
            ],
            (
                f"/api/boards/{facts['ids']['source_board_id']}/widgets",
                "source_widgets",
                facts["source_widgets"],
            ),
            (
                f"/api/dashboards/{facts['ids']['source_dashboard_id']}",
                "source_dashboard",
                facts["source_dashboard"],
            ),
        ]:
            response = client.request("GET", path)
            parsed = type(wanted).model_validate_json(response.content, strict=True)
            ignored = volatile.get(step, set())
            if (
                response.status_code != 200
                or parsed.model_dump(exclude=ignored) != wanted.model_dump(exclude=ignored)
                or _uuid(response.headers.get("X-Request-ID")) is None
            ):
                raise ValueError("Fresh Chart/source state differs")
        for key in ("board_id", "import_id"):
            response = client.request("GET", f"/api/boards/{facts['ids'][key]}")
            if response.status_code != 404:
                raise ValueError("Owned Chart Board survives purge")
        return {"charts_archived": 1, "chart_sources_preserved": 1}, issues
    except (KeyError, TypeError, ValueError, ValidationError, IndexError, SampleClientError):
        return {}, ["Chart final source/owned state could not be certified"]


def certify_retained_chart_dashboards(
    client: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
    run_directory: Path,
) -> tuple[tuple[str, ...], list[str]]:
    try:
        facts = _facts(dataset, manifest, admin_id)
        issues: list[str] = []
        seen: set[str] = set()
        counts = {"control_requests_verified": 0}
        verify_chart_evidence(
            dataset, manifest, facts["action"], facts["result"], admin_id, seen, counts, issues
        )
        if issues:
            raise ValueError("Chart write contract invalid")
        native = {}
        positions = {}
        attempts = {}
        finished_attempts = set()
        for path in run_directory.rglob("*.jsonl"):
            for index, line in enumerate(path.read_text().splitlines()):
                event = json.loads(line)
                if event.get("event") == "request_started":
                    attempt = _uuid(event["attempt_id"])
                    if attempt in attempts:
                        raise ValueError("Duplicate native attempt")
                    attempts[attempt] = (path, index, event)
                elif event.get("event") == "request_finished":
                    attempt = _uuid(event["attempt_id"])
                    if attempt in finished_attempts or attempt not in attempts:
                        raise ValueError("Unmatched or repeated native finished attempt")
                    source, start_index, started = attempts[attempt]
                    if source != path:
                        raise ValueError("Native attempt crosses journals")
                    finished_attempts.add(attempt)
                    if event.get("request_id"):
                        request = _uuid(event["request_id"])
                        if request in native:
                            raise ValueError("Duplicate native request")
                        native[request] = (event, started)
                        positions[request] = (path, start_index, index)
        from operations.sample.verification.route_coverage import route_template

        for row in [*facts["receipts"], *facts["result"]["request_evidence"]]:
            finished, started = native[row["request_id"]]
            template = route_template(row["method"], row["path"])
            if (
                template is None
                or type(finished["status_code"]) is not int
                or (started["method"], started["route_template"], finished["status_code"])
                != (row["method"], template, row["status_code"])
            ):
                raise ValueError("Original native Chart receipt differs")
        ordered = [
            positions[next(row["request_id"] for row in facts["receipts"] if row["step"] == step)]
            for step in (
                "attach_dashboard_chart",
                "read_populated_dashboard",
                "usage_admin",
                "clear_chart_dashboard",
            )
        ]
        if len({row[0] for row in ordered}) != 1 or any(
            before[2] >= after[1] for before, after in zip(ordered, ordered[1:], strict=False)
        ):
            raise ValueError("Native populated Dashboard read is outside append/usage/clear")
        dashboard_id = facts["ids"]["dashboard_id"]
        create = facts["single"]["create_chart_dashboard"]
        clear = next(row for row in facts["receipts"] if row["step"] == "clear_chart_dashboard")
        if (
            create["request_body"] is None
            or clear["request_body"] != {"revision": 2, "widgets": []}
            or create["actor_id"] != admin_id
            or clear["actor_id"] != admin_id
        ):
            raise ValueError("Dashboard create/clear provenance differs")
        response = client.request("GET", f"/api/dashboards/{dashboard_id}")
        _uuid(response.headers.get("X-Request-ID"))
        current = DashboardResponse.model_validate_json(response.content, strict=True)
        if (
            response.status_code != 200
            or current != facts["dashboard"]
            or current.revision != 4
            or not current.is_deleted
            or current.widgets
        ):
            raise ValueError("Retained Dashboard current identity/state differs")
        return (dashboard_id,), []
    except (
        KeyError,
        TypeError,
        ValueError,
        ValidationError,
        IndexError,
        OSError,
        SampleClientError,
    ):
        return (), [
            "Owned Chart Dashboard count credit lacks original native provenance/current state"
        ]
