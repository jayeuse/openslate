"""Read-only final-state verification for OpenView sample controls."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import UUID

from operations.sample.blueprint import SampleDataset
from operations.sample.board_text import dashboard_name, report_names, view_name
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.openview_queries import select_openview_target
from operations.sample.verification.core import SampleVerificationError, list_all_rows


def verify_openview_controls(
    admin: SampleClient,
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    *,
    admin_id: str,
) -> tuple[dict[str, int], list[str]]:
    """Read back net-zero control state without trusting action or object mappings."""
    counts = {
        "records": 0,
        "relationships": 0,
        "views_restored": 0,
        "dashboards_restored": 0,
        "reports_restored": 0,
        "schedules_unchanged": 0,
        "query_outcomes": 0,
    }
    issues: list[str] = []
    try:
        if str(UUID(admin_id)) != admin_id.lower():
            issues.append("OpenView control verifier received a noncanonical administrator ID")
        records = list_all_rows(admin, "/api/records", params={"deleted": "include"})
        counts["records"] = len(records)
        if len(records) != sum(dataset.module_counts.values()):
            issues.append("temporary OpenView records remain or generated record totals changed")
        relationships = list_all_rows(admin, "/api/relationships", params={"availability": "all"})
        counts["relationships"] = len(relationships)
        if len(relationships) != len(dataset.edges) or any(
            row.get("is_deleted") is not False for row in relationships
        ):
            issues.append("temporary relationship deletion changed the final relationship graph")

        department, module, _ = select_openview_target(dataset)
        layout = dataset.organization.content.data.layouts[0]
        expected_view = view_name(module.key, layout, organization=dataset.organization)
        # Catalogue rows expose department_name; population's name fallback authors the key.
        expected_dashboard = dashboard_name(department, organization=dataset.organization)
        group_name = next((field.name for field in module.fields if field.type == "Select"), None)
        expected_report, _ = report_names(
            module.key, "daily", group_name, organization=dataset.organization
        )
        views = list_all_rows(admin, "/api/views", params={"deleted": "include"})
        dashboards = list_all_rows(admin, "/api/dashboards", params={"deleted": "include"})
        reports = list_all_rows(admin, "/api/reports", params={"deleted": "include"})
        view_matches = [row for row in views if row.get("name") == expected_view]
        dashboard_matches = [row for row in dashboards if row.get("name") == expected_dashboard]
        report_matches = [row for row in reports if row.get("name") == expected_report]
        if len(view_matches) != 1 or view_matches[0].get("is_deleted") is not False:
            issues.append("saved View was not restored to its authored state")
        else:
            counts["views_restored"] = 1
        if len(dashboard_matches) != 1 or dashboard_matches[0].get("is_deleted") is not False:
            issues.append("Dashboard was not restored to its authored state")
        else:
            counts["dashboards_restored"] = 1
        if len(report_matches) != 1 or report_matches[0].get("is_deleted") is not False:
            issues.append("Report was not restored to its authored state")
        else:
            counts["reports_restored"] = 1
        if len(report_matches) == 1:
            report_id = report_matches[0].get("id")
            response = admin.request("GET", f"/api/reports/{report_id}/schedule")
            if response.status_code != 200:
                issues.append("Report schedule could not be read after its reversible edit")
            else:
                schedule = response.json()
                if (
                    not isinstance(schedule, Mapping)
                    or schedule.get("enabled") is not False
                    or schedule.get("cadence") != "daily"
                    or schedule.get("timezone_name") != dataset.organization.identity.timezone
                    or schedule.get("local_time") != "09:00"
                    or schedule.get("weekday") is not None
                    or schedule.get("month_day") is not None
                ):
                    issues.append("Report schedule was not restored to its authored policy")
                else:
                    counts["schedules_unchanged"] = 1
        results = manifest.get("control_results")
        if not isinstance(results, list):
            issues.append("OpenView query result journal is missing")
        else:
            expected_queries = {
                "record_query",
                "grouped_query",
                "window_query",
                "aggregate_groups",
                "aggregate_scalar",
                "aggregate_date_series",
                "aggregate_snapshot_groups",
                "aggregate_snapshot_date_series",
                "aggregate_snapshots",
            }
            for operation in expected_queries:
                key = f"control:{operation}"
                result = next(
                    (
                        row.get("safe_result", row)
                        for row in results
                        if isinstance(row, Mapping) and row.get("action_key") == key
                    ),
                    None,
                )
                total = result.get("query_total") if isinstance(result, Mapping) else None
                if type(total) is not int or total < 0:
                    issues.append(f"OpenView query outcome is missing for {operation}")
                else:
                    counts["query_outcomes"] += 1
                    if operation == "aggregate_snapshots" and isinstance(result, Mapping):
                        totals = result.get("query_totals")
                        if (
                            not isinstance(totals, list)
                            or len(totals) != 2
                            or any(type(value) is not int or value < 0 for value in totals)
                            or sum(totals) != total
                        ):
                            issues.append("OpenView batch snapshot outcome is incomplete")
    except (SampleClientError, SampleVerificationError, ValueError):
        issues.append("OpenView final control state could not be read")
    from operations.sample.controls.charts_verification import verify_chart_controls

    chart_counts, chart_issues = verify_chart_controls(admin, dataset, manifest, admin_id)
    counts.update(chart_counts)
    issues.extend(chart_issues)
    return counts, issues
