"""Read and dispose only the temporary Report owned by the Jobs control."""

import csv
import io
from collections.abc import Callable

import httpx
from pydantic import BaseModel, ValidationError

from app.common.listing import PaginationMetadata
from app.systems.openview.reports.schedule_schemas import ScheduleResponse
from app.systems.openview.reports.schemas import ReportResponse, ReportRunResponse
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleMutationResponse,
    LifecyclePurgePreviewResponse,
    LifecyclePurgeRequest,
)
from operations.sample.phases.actions import SamplePhaseActionError, _read_json


def _model[T: BaseModel](schema: type[T], response: httpx.Response, step: str) -> T:
    try:
        return schema.model_validate_json(response.content)
    except ValidationError:
        raise SamplePhaseActionError("Jobs control response shape is invalid", step=step) from None


def read_owned_output(
    request: Callable[..., httpx.Response],
    report: ReportResponse,
    field_name: str,
) -> ReportRunResponse:
    root = f"/api/reports/{report.id}"
    page = _read_json(
        request("GET", root + "/runs", "read_job_runs", params={"limit": 100}), step="read_job_runs"
    )
    try:
        metadata = PaginationMetadata.model_validate(page["pagination"])
        runs = [ReportRunResponse.model_validate(value) for value in page["items"]]
    except (ValidationError, KeyError, TypeError):
        raise SamplePhaseActionError(
            "Recovered output collection is invalid", step="read_job_runs"
        ) from None
    if (
        len(runs) != 1
        or metadata.total != 1
        or metadata.count != 1
        or metadata.has_more
        or metadata.offset != 0
    ):
        raise SamplePhaseActionError(
            "Recovered report has no unique successful output", step="read_job_runs"
        )
    run = _model(
        ReportRunResponse,
        request("GET", root + f"/runs/{runs[0].id}", "read_job_output"),
        "read_job_output",
    )
    if (
        run != runs[0]
        or run.report_id != report.id
        or run.recipe_revision != report.revision
        or run.row_count != 0
        or run.headings != [field_name]
    ):
        raise SamplePhaseActionError(
            "Recovered output differs from its owned zero-row recipe", step="read_job_output"
        )
    csv_reply = request("GET", root + f"/runs/{run.id}/csv", "read_job_csv")
    try:
        rows = list(csv.reader(io.StringIO(csv_reply.content.decode("utf-8")), strict=True))
    except (UnicodeError, csv.Error):
        raise SamplePhaseActionError("Recovered CSV is invalid", step="read_job_csv") from None
    if (
        len(csv_reply.content) > 1_000_000
        or rows != [run.headings]
        or csv_reply.headers.get("Content-Type", "").lower().replace(" ", "")
        != "text/csv;charset=utf-8"
        or csv_reply.headers.get("Content-Disposition")
        != f'attachment; filename="report-{run.id}.csv"'
        or csv_reply.headers.get("X-Content-Type-Options") != "nosniff"
    ):
        raise SamplePhaseActionError("Recovered CSV differs from its output", step="read_job_csv")
    return run


def dispose_owned_report(
    request: Callable[..., httpx.Response],
    report: ReportResponse,
    summary: ScheduleResponse,
    password: str,
) -> str:
    root = f"/api/reports/{report.id}"
    disabled = _model(
        ScheduleResponse,
        request(
            "PATCH",
            root + "/schedule",
            "disable_job_schedule",
            body={"revision": summary.revision, "enabled": False},
        ),
        "disable_job_schedule",
    )
    if disabled.id != summary.id or disabled.enabled or disabled.next_due_at is not None:
        raise SamplePhaseActionError(
            "Owned job schedule was not disabled", step="disable_job_schedule"
        )
    request("DELETE", root, "archive_job_report", 204, params={"revision": report.revision})
    archived = _model(
        ReportResponse, request("GET", root, "read_archived_job_report"), "read_archived_job_report"
    )
    if archived.id != report.id or archived.name != report.name or not archived.is_deleted:
        raise SamplePhaseActionError(
            "Owned report archive differs", step="read_archived_job_report"
        )
    preview = _model(
        LifecyclePurgePreviewResponse,
        request("POST", root + "/purge/preview", "preview_job_report_purge"),
        "preview_job_report_purge",
    )
    if (
        preview.impact.target_type != "report"
        or preview.impact.target_id != report.id
        or preview.impact.operation != "purge"
        or preview.impact.blockers
        or preview.confirmation_name != report.name
    ):
        raise SamplePhaseActionError(
            "Report purge preview differs from the owned target", step="preview_job_report_purge"
        )
    payload = LifecyclePurgeRequest(
        token=preview.token, confirmation_name=preview.confirmation_name, password=password
    )
    purged = _model(
        LifecycleMutationResponse,
        request("POST", root + "/purge", "purge_job_report", body=payload.model_dump(mode="json")),
        "purge_job_report",
    )
    if (
        purged.impact.target_type != "report"
        or purged.impact.target_id != report.id
        or purged.impact.operation != "purge"
        or purged.operation_id is None
    ):
        raise SamplePhaseActionError("Owned report purge result differs", step="purge_job_report")
    request("GET", root, "read_purged_job_report", 404)
    return str(purged.operation_id)
