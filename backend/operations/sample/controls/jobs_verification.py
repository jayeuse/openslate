"""Receipt linkage and read-only final disposal proof for the owned Jobs journey."""

import re
from collections.abc import Mapping
from typing import Any
from uuid import UUID

from pydantic import ValidationError

from app.common.listing import PaginationMetadata
from app.systems.manage.jobs.schemas import JobResponse
from app.systems.openview.reports.schedule_schemas import ScheduleResponse
from app.systems.openview.reports.schemas import ReportResponse, ReportRunResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient, SampleClientError
from operations.sample.controls.jobs import (
    CONTROL_KEY,
    MAX_PAGES,
    OPERATIONS,
    PAGE_LIMIT,
    plan_job_controls,
)
from operations.sample.controls.request_verification import _canonical_uuid
from operations.sample.packs.phase_types import PhaseAction

KEYS = {
    "step",
    "actor_key",
    "actor_id",
    "method",
    "path",
    "expected_status",
    "status_code",
    "request_id",
}
PAGE_STEP = re.compile(r"^(poll_job_(?:failed|succeeded)|purged_job_absence)_(\d+)_(\d+)$")


def _facts(
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    admin_id: str,
    override: tuple[PhaseAction, Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    results = {
        row["action_key"]: row for row in manifest["control_results"] if isinstance(row, Mapping)
    }
    if override is not None:
        results[override[0].key] = override[1]
    planned = plan_job_controls(dataset)
    prepared, failed, recovered = [results[action.key] for action in planned]
    for action, result in zip(planned, (prepared, failed, recovered), strict=True):
        if (
            result["actor_key"] != "admin"
            or result["actor_id"] != admin_id
            or result["target_key"] != CONTROL_KEY
            or result["outcome"] != "completed"
            or any(result.get(key) is not value for key, value in action.expected_end_state.items())
        ):
            raise ValueError("Jobs action attribution or outcome differs")
    mappings = manifest["mappings"]
    ids = {
        kind: mappings[kind][CONTROL_KEY]
        for kind in (
            "jobs_reports",
            "jobs_schedules",
            "jobs_work",
            "jobs_runs",
        )
    }
    source = prepared["source"]
    for key, binding in (
        ("module_id", "module"),
        ("field_id", "field"),
        ("title_id", "title_field"),
    ):
        if (
            _canonical_uuid(source[key]) is None
            or source[key] != mappings["sandbox_lifecycle"][binding]
        ):
            raise ValueError("Jobs source is not an owned lifecycle binding")
    if (
        source["field_id"] == source["title_id"]
        or source["field_name"] != planned[0].values["field_name"]
    ):
        raise ValueError("Jobs optional field differs")
    report = ReportResponse.model_validate(prepared["report"])
    policy = ScheduleResponse.model_validate(prepared["schedule"])
    old = JobResponse.model_validate(failed["job"])
    retry = JobResponse.model_validate(recovered["retry"])
    success = JobResponse.model_validate(recovered["success"])
    run = ReportRunResponse.model_validate(recovered["run"])
    if (
        any(_canonical_uuid(value) is None for value in ids.values())
        or str(report.id) != ids["jobs_reports"]
        or str(policy.id) != ids["jobs_schedules"]
        or str(old.id) != ids["jobs_work"]
        or str(run.id) != ids["jobs_runs"]
        or str(report.module_id) != source["module_id"]
        or report.is_deleted
        or report.recipe.fields[0].field_id != UUID(source["field_id"])
        or len(report.recipe.fields) != 1
        or report.recipe.fields[0].expected_type != "long_text"
        or policy.report_id != report.id
        or not policy.enabled
        or policy.timezone_name != "UTC"
        or policy.cadence != "daily"
        or policy.next_due_at is None
    ):
        raise ValueError("Jobs Report or schedule identity differs")
    link = f"/openview?section=reports&report={report.id}"
    for job in (old, retry, success):
        if (
            job.id != old.id
            or job.kind != "report-run"
            or job.subject_label != report.name
            or job.subject_link != link
            or job.scheduled_for != policy.next_due_at
        ):
            raise ValueError("Jobs occurrence is not bound to the created Report")
    if (
        old.state != "failed"
        or old.attempts != 5
        or old.failure_code != "attempts_exhausted"
        or not old.can_retry
        or old.last_attempt_at is None
        or retry.state != "pending"
        or retry.attempts != 0
        or retry.failure_code is not None
        or retry.failure_label is not None
        or retry.can_retry
        or retry.last_attempt_at != old.last_attempt_at
        or retry.next_attempt_at is None
        or success.state != "succeeded"
        or success.attempts != 1
        or success.can_retry
        or success.failure_code is not None
        or success.failure_label is not None
        or success.last_attempt_at is None
    ):
        raise ValueError("Jobs failed/reset/recovery receipts differ")
    for receipt, job in ((failed, old), (recovered, success)):
        schedule = ScheduleResponse.model_validate(receipt["schedule"])
        last = schedule.last_run
        if (
            schedule.id != policy.id
            or schedule.report_id != report.id
            or last is None
            or last.state != job.state
            or last.finished_at is None
            or last.finished_at.tzinfo is None
            or job.last_attempt_at is None
            or job.last_attempt_at.tzinfo is None
            or last.finished_at < job.last_attempt_at
            or last.failure_label != job.failure_label
        ):
            raise ValueError("Jobs completion time/summary differs")
    if (
        run.report_id != report.id
        or run.recipe_revision != report.revision
        or run.row_count != 0
        or run.headings != [source["field_name"]]
        or _canonical_uuid(recovered["purge_operation_id"]) is None
    ):
        raise ValueError("Jobs output or purge receipt differs")
    expected_mappings = [
        [
            {"kind": "jobs_reports", "logical_id": CONTROL_KEY, "server_id": ids["jobs_reports"]},
            {
                "kind": "jobs_schedules",
                "logical_id": CONTROL_KEY,
                "server_id": ids["jobs_schedules"],
            },
        ],
        [{"kind": "jobs_work", "logical_id": CONTROL_KEY, "server_id": ids["jobs_work"]}],
        [{"kind": "jobs_runs", "logical_id": CONTROL_KEY, "server_id": ids["jobs_runs"]}],
    ]
    if any(
        result["mappings"] != expected
        for result, expected in zip((prepared, failed, recovered), expected_mappings, strict=True)
    ):
        raise ValueError("Jobs mapping admission receipts differ")
    return {
        "report": report,
        "policy": policy,
        "job": old,
        "run": run,
        "source": source,
        "results": (prepared, failed, recovered),
    }


def _pages(result: Mapping[str, Any]) -> dict[str, tuple[str, str, int]]:
    pages = result["pages"]
    if not isinstance(pages, list) or not pages:
        raise ValueError("Jobs page receipts missing")
    expected: dict[str, tuple[str, str, int]] = {}
    grouped: dict[tuple[str, int], list[PaginationMetadata]] = {}
    for row in pages:
        match = PAGE_STEP.fullmatch(row["step"])
        if match is None or row["step"] in expected:
            raise ValueError("Jobs page step is invalid")
        phase, cycle, index = match[1], int(match[2]), int(match[3])
        page = PaginationMetadata.model_validate(
            {key: value for key, value in row.items() if key != "step"}
        )
        if (
            any(type(row[key]) is not int for key in ("limit", "offset", "count", "total"))
            or page.limit != PAGE_LIMIT
            or page.offset != index * PAGE_LIMIT
            or page.count != min(PAGE_LIMIT, max(page.total - page.offset, 0))
            or page.has_more is not (page.offset + page.count < page.total)
            or index >= MAX_PAGES
            or page.total > PAGE_LIMIT * MAX_PAGES
        ):
            raise ValueError("Jobs page metadata differs")
        grouped.setdefault((phase, cycle), []).append(page)
        expected[row["step"]] = ("GET", "/api/jobs", 200)
    for group in grouped.values():
        if (
            group[0].offset != 0
            or group[-1].has_more
            or any(
                page.offset != index * PAGE_LIMIT or page.total != group[0].total
                for index, page in enumerate(group)
            )
        ):
            raise ValueError("Jobs observation scan is incomplete")
    return expected


def verify_job_evidence(
    dataset: SampleDataset,
    manifest: Mapping[str, Any],
    action: PhaseAction,
    result: Mapping[str, Any],
    admin_id: str,
    seen_request_ids: set[str],
    observed: dict[str, int],
    issues: list[str],
) -> None:
    from operations.sample.verification.route_coverage import SEEDER_ROUTES, route_template

    try:
        if action not in plan_job_controls(dataset) or _canonical_uuid(admin_id) is None:
            raise ValueError("Jobs action not admitted")
        facts = _facts(dataset, manifest, admin_id, (action, result))
        root = f"/api/reports/{facts['report'].id}"
        operation = action.values["operation"]
        if operation == OPERATIONS[0]:
            contract = {
                "job_source_module": ("GET", f"/api/modules/{facts['source']['module_id']}", 200),
                "job_source_field": ("GET", f"/api/fields/{facts['source']['field_id']}", 200),
                "create_job_report": ("POST", "/api/reports", 201),
                "prepare_job_schedule": ("POST", root + "/schedule", 201),
            }
        elif operation == OPERATIONS[1]:
            contract = {**_pages(result), "job_schedule_failed": ("GET", root + "/schedule", 200)}
        else:
            pages = _pages(result)
            polling = {step: route for step, route in pages.items() if step.startswith("poll_job_")}
            absence = {
                step: route
                for step, route in pages.items()
                if step.startswith("purged_job_absence_")
            }
            if not polling or not absence:
                raise ValueError("Jobs recovery or absence scan missing")
            contract = {
                "retry_owned_job": ("POST", f"/api/jobs/report-run/{facts['job'].id}/retry", 200),
                **polling,
                "job_schedule_succeeded": ("GET", root + "/schedule", 200),
                "read_job_runs": ("GET", root + "/runs", 200),
                "read_job_output": ("GET", root + f"/runs/{facts['run'].id}", 200),
                "read_job_csv": ("GET", root + f"/runs/{facts['run'].id}/csv", 200),
                "disable_job_schedule": ("PATCH", root + "/schedule", 200),
                "archive_job_report": ("DELETE", root, 204),
                "read_archived_job_report": ("GET", root, 200),
                "preview_job_report_purge": ("POST", root + "/purge/preview", 200),
                "purge_job_report": ("POST", root + "/purge", 200),
                "read_purged_job_report": ("GET", root, 404),
                **absence,
            }
        rows = result["request_evidence"]
        if not isinstance(rows, list) or [row["step"] for row in rows] != list(contract):
            raise ValueError("Jobs transport receipt sequence differs")
        identifiers = set()
        for row in rows:
            identifier = _canonical_uuid(row["request_id"])
            method, path, status = contract[row["step"]]
            if (
                set(row) != KEYS
                or row["actor_key"] != "admin"
                or row["actor_id"] != admin_id
                or (row["method"], row["path"], row["expected_status"], row["status_code"])
                != (method, path, status, status)
                or (method, route_template(method, path)) not in SEEDER_ROUTES
                or identifier is None
                or identifier in seen_request_ids
                or identifier in identifiers
            ):
                raise ValueError("Jobs transport identity or route differs")
            identifiers.add(identifier)
        seen_request_ids.update(identifiers)
        observed["control_requests_verified"] += len(rows)
    except (ValidationError, KeyError, TypeError, ValueError, IndexError):
        issues.append("Jobs ownership, transport receipts or end-state proof differs")


def verify_jobs_controls(
    client: SampleClient, dataset: SampleDataset, manifest: Mapping[str, Any], admin_id: str
) -> tuple[dict[str, int], list[str]]:
    plan = manifest.get("control_plan", [])
    if not any(isinstance(row, Mapping) and row.get("kind") == "jobs_controls" for row in plan):
        return {}, []
    try:
        facts = _facts(dataset, manifest, admin_id)
        root = f"/api/reports/{facts['report'].id}"
        response = client.request("GET", root)
        if (
            response.status_code != 404
            or _canonical_uuid(response.headers.get("X-Request-ID")) is None
        ):
            raise ValueError("Owned Report remains after purge")
        total = None
        seen_ids: set[UUID] = set()
        for index in range(MAX_PAGES):
            response = client.request(
                "GET",
                "/api/jobs",
                params={"kind": "report-run", "limit": PAGE_LIMIT, "offset": index * PAGE_LIMIT},
            )
            if (
                response.status_code != 200
                or _canonical_uuid(response.headers.get("X-Request-ID")) is None
            ):
                raise ValueError("Jobs final readback unavailable")
            body = response.json()
            raw = body["pagination"]
            page = PaginationMetadata.model_validate(raw)
            if any(type(raw.get(key)) is not int for key in ("limit", "offset", "count", "total")):
                raise ValueError("Jobs final pagination types differ")
            rows = [JobResponse.model_validate(row) for row in body["items"]]
            if (
                page.limit != PAGE_LIMIT
                or page.offset != index * PAGE_LIMIT
                or page.count != len(rows)
                or page.count != min(PAGE_LIMIT, max(page.total - page.offset, 0))
                or page.total > PAGE_LIMIT * MAX_PAGES
                or (total is not None and page.total != total)
                or page.has_more is not (page.offset + len(rows) < page.total)
            ):
                raise ValueError("Jobs final pagination differs")
            total = page.total
            for row in rows:
                if row.kind != "report-run" or row.id in seen_ids:
                    raise ValueError("Jobs final page kind or identity differs")
                seen_ids.add(row.id)
            if any(
                row.id == facts["job"].id or row.subject_link == facts["job"].subject_link
                for row in rows
            ):
                raise ValueError("Owned Report job remains after purge")
            if not page.has_more:
                return {
                    "jobs_failure_observed": 1,
                    "jobs_retry_verified": 1,
                    "jobs_report_purged": 1,
                }, []
        raise ValueError("Jobs final readback exceeded page bound")
    except (SampleClientError, ValidationError, KeyError, TypeError, ValueError, IndexError):
        return {}, ["Jobs control final owned disposal could not be verified"]
