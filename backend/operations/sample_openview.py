"""Sample shared Views, department Dashboards, Reports and disabled schedules."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import date
from typing import Any
from uuid import uuid4

from operations.sample_actors import planned_access_level
from operations.sample_board_text import dashboard_name, report_names, view_name
from operations.sample_client import SampleClient, SampleClientError
from operations.sample_content import SampleContentError, _id, _json, _pages
from operations.sample_packs.interface import OrganizationPack
from operations.sample_packs.registry import default_pack

_DATE_TYPES = {"date", "datetime"}
_NUMBER_TYPES = {"number", "decimal", "int"}
_TEXT_TYPES = {"text", "long_text", "email", "url"}


def _kind(field: Mapping[str, Any]) -> str:
    return str(field.get("type", field.get("field_type", ""))).lower().replace("integer", "int")


def _active_fields(
    module_key: str,
    module_id: str,
    fields: Mapping[str, list[Mapping[str, Any]]],
) -> list[dict[str, Any]]:
    return sorted(
        [
            dict(field)
            for field in fields.get(module_key, [])
            if field.get("module_id", module_id) == module_id
            and not field.get("is_deleted", False)
            and _kind(field) not in {"relationship", ""}
        ],
        key=lambda field: (int(field.get("position", 0)), str(field.get("name", ""))),
    )


def _reference(field: Mapping[str, Any]) -> dict[str, str]:
    return {"field_id": _id(field), "expected_type": _kind(field)}


def _definition(fields: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    return {
        "version": 1,
        "columns": [_reference(field) for field in fields[:12]],
        "filters": [],
        "logic": "and",
        "sort": [],
        "deleted": "exclude",
        "search": None,
        "search_fields": [],
    }


def _source_plans(
    departments: Mapping[str, Mapping[str, Any]],
    modules: Mapping[str, Mapping[str, Any]],
    fields: Mapping[str, list[Mapping[str, Any]]],
    *,
    organization: OrganizationPack | None = None,
) -> dict[str, tuple[tuple[str, Mapping[str, Any], list[dict[str, Any]]], ...]]:
    pack = organization or default_pack()
    if len(departments) != len(pack.catalog.departments) or len(modules) != len(
        pack.catalog.modules
    ):
        raise SampleContentError("OpenView content requires the pack's published structure")
    plans: dict[str, tuple[tuple[str, Mapping[str, Any], list[dict[str, Any]]], ...]] = {}
    for department_key, department in departments.items():
        department_id = _id(department)
        candidates = []
        for module_key, module in modules.items():
            if module.get("department_id") != department_id:
                continue
            active = _active_fields(module_key, _id(module), fields)
            kinds = {_kind(field) for field in active}
            if not active or not kinds & _DATE_TYPES:
                continue
            score = int(bool(kinds & _DATE_TYPES)) * 4
            score += int(bool(kinds & _NUMBER_TYPES)) * 3
            score += int("select" in kinds) * 2 + int(bool(kinds & _TEXT_TYPES))
            candidates.append((score, module_key, module, active))
        candidates.sort(key=lambda item: (-item[0], item[1]))
        if not candidates:
            raise SampleContentError(f"OpenView needs an active report source for {department_key}")
        plans[department_key] = tuple(
            (module_key, module, active) for _, module_key, module, active in candidates[:2]
        )
    return plans


def _view_presentation(
    layout: str,
    fields: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    # The API requires every field a layout uses to be one of the query columns.
    columns = fields[:12]
    ids = [_id(field) for field in columns]
    date_ids = [_id(field) for field in columns if _kind(field) in _DATE_TYPES]
    if not date_ids:
        raise SampleContentError("OpenView layout requires an active date field")
    primary = next((_id(field) for field in columns if _kind(field) in _TEXT_TYPES), ids[0])
    secondary = next((_id(field) for field in columns if _kind(field) == "select"), None)
    group = secondary or primary
    numeric = next((_id(field) for field in columns if _kind(field) in _NUMBER_TYPES), None)
    result: dict[str, Any] = {
        "version": 1,
        "layout": layout,
        "column_field_ids": ids,
        "pinned_field_ids": ids[:1] if layout == "table" else [],
        "density": "comfortable",
        "wrap": False,
        "card_size": "comfortable",
        "primary_field_id": primary if layout in {"grid", "gallery"} else None,
        "secondary_field_id": secondary if layout == "grid" else None,
        "date_field_id": date_ids[0] if layout == "calendar" else None,
        "timeline_start_field_id": date_ids[0] if layout == "timeline" else None,
        "timeline_end_field_id": (date_ids[1] if len(date_ids) > 1 else date_ids[0])
        if layout == "timeline"
        else None,
        "timeline_deadline_field_id": date_ids[-1] if layout == "timeline" else None,
        "timeline_progress_field_id": numeric if layout == "timeline" else None,
        "date_range": "month",
        "scale": "month" if layout == "timeline" else None,
        "group_by_field_id": group if layout == "kanban" else None,
    }
    return result


def _dashboard_widgets(
    module: Mapping[str, Any], fields: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    module_id = _id(module)
    definition = _definition(fields)
    dimension = next((_reference(field) for field in fields if _kind(field) == "select"), None)
    if dimension is None:
        dimension = _reference(fields[0])
    query = {
        "mode": "groups",
        "module_id": module_id,
        "definition": definition,
        "aggregation": "count",
        "measure": None,
        "dimension": dimension,
    }
    return [
        {"widget_type": "summary", "config": {"version": 1, "query": query}},
        {"widget_type": "workload", "config": {"version": 1, "query": query}},
        {
            "widget_type": "records",
            "config": {
                "version": 1,
                "query": {"module_id": module_id, "definition": definition},
            },
        },
        {
            "widget_type": "chart",
            "config": {"version": 1, "chart_type": "bar", "query": query},
        },
    ]


def create_report_run_and_disabled_schedule(
    admin: SampleClient,
    report_id: str,
    cadence: str,
    *,
    weekday: int | None = None,
    organization: OrganizationPack | None = None,
) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    if cadence not in {"daily", "weekly"} or (cadence == "weekly") != (weekday is not None):
        raise ValueError("Report schedules must be disabled daily or weekly policies")
    path = f"/api/reports/{report_id}"
    run = _json(
        admin,
        "POST",
        f"{path}/runs",
        headers={"Idempotency-Key": str(uuid4())},
        expected=(201,),
    )
    if run.get("report_id") != report_id or not isinstance(run.get("row_count"), int):
        raise SampleContentError("Report run response did not match the requested Report")
    policy: dict[str, Any] = {
        "enabled": False,
        "cadence": cadence,
        "timezone_name": (organization or default_pack()).identity.timezone,
        "local_time": "09:00",
    }
    if weekday is not None:
        policy["weekday"] = weekday
    schedule = _json(admin, "POST", f"{path}/schedule", body=policy, expected=(201,))
    if schedule.get("report_id") != report_id or schedule.get("enabled") is not False:
        raise SampleContentError("Report schedule was not saved disabled")
    return run, schedule


def _module_writer(
    pack: OrganizationPack,
    department: str,
    module: str,
    fallback: SampleClient,
    actor_clients: Mapping[str, SampleClient] | None,
) -> SampleClient:
    if actor_clients is None:
        return fallback
    lead = pack.content.data.leads[department]
    candidates = (lead, *(key for key in pack.actors.team_keys[department] if key != lead))
    selected = next(
        (
            key
            for key in candidates
            if key in actor_clients and planned_access_level(pack, key, department, module) >= 3
        ),
        None,
    )
    if selected is None:
        raise SampleContentError(f"OpenView module manager is unavailable for {module}")
    return actor_clients[selected]


def populate_openview(
    admin: SampleClient,
    *,
    departments: Mapping[str, Mapping[str, Any]],
    modules: Mapping[str, Mapping[str, Any]],
    fields: Mapping[str, list[Mapping[str, Any]]],
    anchor_date: date,
    seed: int,
    writers: Mapping[str, SampleClient] | None = None,
    actor_clients: Mapping[str, SampleClient] | None = None,
    organization: OrganizationPack | None = None,
) -> Mapping[str, int]:
    """Each department's shared views, Dashboard and Reports, built by its writer (lead)."""
    del anchor_date, seed
    pack = organization or default_pack()
    plans = _source_plans(departments, modules, fields, organization=pack)
    counts = {
        "views": 0,
        "dashboards": 0,
        "dashboard_widgets": 0,
        "reports": 0,
        "report_runs": 0,
        "schedules": 0,
        "disabled_schedules": 0,
    }

    for department_key, department in departments.items():
        writer = (writers or {}).get(department_key, admin)
        selected_module_key, selected_module, selected_fields = plans[department_key][0]
        module_writer = _module_writer(
            pack, department_key, selected_module_key, writer, actor_clients
        )
        query = _definition(selected_fields)
        for layout in pack.content.data.layouts:
            name = view_name(selected_module_key, layout, organization=pack)
            saved = _json(
                module_writer,
                "POST",
                "/api/views",
                body={
                    "module_id": _id(selected_module),
                    "name": name,
                    "is_default": False,
                    "definition": query,
                    "presentation": _view_presentation(layout, selected_fields),
                },
                expected=(201,),
            )
            logical_id = f"department:{department_key}:view:{selected_module_key}:{layout}"
            module_writer.record_mapping("views", logical_id, _id(saved))
            counts["views"] += 1

        widgets = _dashboard_widgets(selected_module, selected_fields)
        dashboard = _json(
            writer,
            "POST",
            "/api/dashboards",
            body={
                "department_id": _id(department),
                "name": dashboard_name(
                    str(department.get("name", department_key)), organization=pack
                ),
                "position": 0,
                "refresh_cadence": "manual",
                "widgets": widgets,
            },
            expected=(201,),
        )
        dashboard_id = _id(dashboard)
        saved_widgets = dashboard.get("widgets")
        if not isinstance(saved_widgets, list) or len(saved_widgets) != 4:
            raise SampleContentError("Dashboard response did not contain its four saved widgets")
        writer.record_mapping("dashboards", f"department:{department_key}:dashboard", dashboard_id)
        for index, widget in enumerate(saved_widgets):
            if not isinstance(widget, dict):
                raise SampleContentError("Dashboard response contains an invalid widget")
            writer.record_mapping(
                "widgets",
                f"department:{department_key}:dashboard:widget:{index + 1:02d}",
                _id(widget),
            )
        counts["dashboards"] += 1
        counts["dashboard_widgets"] += len(saved_widgets)

        for report_index, (module_key, module, active_fields) in enumerate(plans[department_key]):
            module_writer = _module_writer(pack, department_key, module_key, writer, actor_clients)
            module_id = _id(module)
            recipe_fields = [_reference(field) for field in active_fields[:8]]
            group_by = next(
                (_reference(field) for field in active_fields if _kind(field) == "select"),
                None,
            )
            cadence = "daily" if report_index == 0 else "weekly"
            group_field = next((field for field in active_fields if _kind(field) == "select"), None)
            report_name, subtitle = report_names(
                module_key,
                cadence,
                str(group_field["name"]) if group_field else None,
                organization=pack,
            )
            report = _json(
                module_writer,
                "POST",
                "/api/reports",
                body={
                    "module_id": module_id,
                    "name": report_name,
                    "subtitle": subtitle,
                    "recipe": {
                        "version": 1,
                        "fields": recipe_fields,
                        "filters": [],
                        "logic": "and",
                        "sorts": [],
                        "group_by": group_by,
                        "include_row_count": True,
                    },
                },
                expected=(201,),
            )
            report_id = _id(report)
            logical_report = f"department:{department_key}:report:{report_index + 1:02d}"
            module_writer.record_mapping("reports", logical_report, report_id)
            run, schedule = create_report_run_and_disabled_schedule(
                module_writer,
                report_id,
                cadence,
                weekday=1 if cadence == "weekly" else None,
                organization=pack,
            )
            if not run.get("id") or schedule.get("enabled") is not False:
                raise SampleContentError("Report output or disabled schedule was not persisted")
            counts["reports"] += 1
            counts["report_runs"] += 1
            counts["schedules"] += 1
            counts["disabled_schedules"] += 1
    return counts


def verify_openview(
    admin: SampleClient, *, mappings: Mapping[str, Mapping[str, str]]
) -> Mapping[str, int]:
    counts = {
        "views": 0,
        "dashboards": 0,
        "dashboard_widgets": 0,
        "reports": 0,
        "report_runs": 0,
        "report_outputs": 0,
        "schedules": 0,
        "disabled_schedules": 0,
        "read_failures": 0,
    }
    module_ids = mappings.get("modules", {})
    if not module_ids:
        counts["read_failures"] += 1
    for module_id in module_ids.values():
        try:
            counts["views"] += len(
                _pages(admin, "/api/views", {"module_id": module_id, "deleted": "include"})
            )
        except (SampleClientError, SampleContentError):
            counts["read_failures"] += 1
    try:
        dashboards = _pages(admin, "/api/dashboards", {"deleted": "include"})
        counts["dashboards"] = len(dashboards)
        counts["dashboard_widgets"] = sum(
            len(item.get("widgets", []))
            for item in dashboards
            if isinstance(item.get("widgets"), list)
        )
    except (SampleClientError, SampleContentError):
        counts["read_failures"] += 1
        dashboards = []
    try:
        reports = _pages(admin, "/api/reports", {"deleted": "include"})
    except (SampleClientError, SampleContentError):
        counts["read_failures"] += 1
        reports = []
    counts["reports"] = len(reports)
    for report in reports:
        try:
            report_id = _id(report)
        except SampleContentError:
            counts["read_failures"] += 1
            continue
        try:
            runs = _pages(admin, f"/api/reports/{report_id}/runs")
            counts["report_runs"] += len(runs)
            for run in runs:
                run_id = _id(run)
                response = admin.request("GET", f"/api/reports/{report_id}/runs/{run_id}/csv")
                if (
                    response.status_code == 200
                    and response.headers.get("content-type", "").startswith("text/csv")
                    and response.content
                ):
                    counts["report_outputs"] += 1
                else:
                    counts["read_failures"] += 1
        except (SampleClientError, SampleContentError):
            counts["read_failures"] += 1
        try:
            response = admin.request("GET", f"/api/reports/{report_id}/schedule")
            if response.status_code == 200:
                value = response.json()
                if isinstance(value, dict):
                    counts["schedules"] += 1
                    counts["disabled_schedules"] += int(value.get("enabled") is False)
                else:
                    counts["read_failures"] += 1
            elif response.status_code != 404:
                counts["read_failures"] += 1
        except (SampleClientError, ValueError):
            counts["read_failures"] += 1
    return counts
