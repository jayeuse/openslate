"""Owned Report failure, Jobs retry and disposal around the existing field lifecycle."""

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from time import monotonic as _monotonic
from time import sleep as _sleep
from typing import Any

import httpx
from pydantic import ValidationError
from uuid6 import uuid7

from app.common.listing import PaginationMetadata
from app.systems.manage.jobs.schemas import JobResponse
from app.systems.openview.reports.schedule_schemas import ScheduleResponse
from app.systems.openview.reports.schemas import ReportCreate, ReportResponse
from app.systems.sandbox.fields.schemas import FieldResponse
from app.systems.sandbox.modules.schemas import ModuleResponse
from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClientError, SampleWriteOutcomeUnknown
from operations.sample.controls.jobs_report import _model
from operations.sample.controls.sandbox import fixture_values
from operations.sample.packs.phase_types import PhaseAction, PhaseJsonValue
from operations.sample.phases.actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _client,
    _mapped_id,
    _read_json,
    _record_mapping,
    _request,
    _request_id,
    _result,
)

OPERATIONS = ("jobs_prepare", "jobs_observe_failure", "jobs_retry_recover_cleanup")
CONTROL_KEY = "control:jobs_retry"
PAGE_LIMIT, MAX_PAGES = 100, 100
FAILURE_SECONDS, RECOVERY_SECONDS, POLL_SECONDS = 300.0, 180.0, 2.0


def _now_utc() -> datetime:
    return datetime.now(UTC)


def plan_job_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    if dataset.organization.phases is None:
        return ()
    outcomes: tuple[dict[str, PhaseJsonValue], ...] = (
        {"prepared": True},
        {"failed": True},
        {"retried": True, "recovered": True, "purged": True},
    )
    return tuple(
        PhaseAction(
            key=f"control:{operation}",
            phase="reorganization",
            kind="jobs_controls",
            actor_key="admin",
            target_key=CONTROL_KEY,
            values={**fixture_values(dataset), "operation": operation},
            expected_status=200,
            expected_detail=None,
            expected_end_state=outcome,
        )
        for operation, outcome in zip(OPERATIONS, outcomes, strict=True)
    )


class _Journey:
    def __init__(
        self, action: PhaseAction, context: PhaseExecutionContext, on_substep: PhaseSubstep | None
    ):
        self.action, self.context, self.on_substep = action, context, on_substep
        self.evidence: list[dict[str, object]] = []
        self.mappings: list[dict[str, str]] = []
        self.pages: list[dict[str, object]] = []
        self.state: dict[str, Any] = context.private_values.setdefault("jobs_control", {})

    def call(
        self,
        method: str,
        path: str,
        step: str,
        expected: int = 200,
        *,
        body: Mapping[str, Any] | None = None,
        params: Mapping[str, Any] | None = None,
    ) -> httpx.Response:
        try:
            response = _request(
                self.action,
                self.context,
                [],
                actor_key="admin",
                method=method,
                path=path,
                step=step,
                expected=expected,
                on_substep=self.on_substep,
                json_body=body,
                params=params,
            )
        except SampleWriteOutcomeUnknown as error:
            # Reconcile only this owned identity; an ambiguous POST is never a successful receipt.
            client = _client(self.context, "admin", step=step)
            path = (
                f"/api/reports/{self.state['report'].id}"
                if "report" in self.state
                else "/api/reports"
            )
            query = (
                None
                if "report" in self.state
                else {
                    "module_id": self.state["module_id"],
                    "search": self.state["name"],
                    "limit": 1,
                }
            )
            try:
                if step == "retry_owned_job":
                    self.scan("reconcile_owned_job", 0, _monotonic() + 30)
                else:
                    client.request("GET", path, params=query)
            except (SampleClientError, SamplePhaseActionError):
                pass
            raise SamplePhaseActionError(
                "Write outcome is unknown; no replay or cleanup attempted",
                step=step,
                request_id=error.request_id,
            ) from None
        identifier = _request_id(response)
        if identifier is None:
            raise SamplePhaseActionError("Jobs response request identity is missing", step=step)
        self.evidence.append(
            {
                "step": step,
                "actor_key": "admin",
                "actor_id": self.context.user_ids["admin"],
                "method": method,
                "path": path,
                "expected_status": expected,
                "status_code": response.status_code,
                "request_id": identifier,
            }
        )
        return response

    def map(self, kind: str, identifier: str) -> None:
        _record_mapping(
            self.context,
            _client(self.context, "admin", step=self.action.key),
            kind,
            CONTROL_KEY,
            identifier,
            self.mappings,
        )

    def prepare(self) -> dict[str, object]:
        module_id = _mapped_id(self.context, "sandbox_lifecycle", "module", step=self.action.key)
        field_id = _mapped_id(self.context, "sandbox_lifecycle", "field", step=self.action.key)
        title_id = _mapped_id(
            self.context, "sandbox_lifecycle", "title_field", step=self.action.key
        )
        module = _model(
            ModuleResponse,
            self.call("GET", f"/api/modules/{module_id}", "job_source_module"),
            "job_source_module",
        )
        field = _model(
            FieldResponse,
            self.call("GET", f"/api/fields/{field_id}", "job_source_field"),
            "job_source_field",
        )
        if (
            str(module.id) != module_id
            or module.is_deleted
            or module.deleted_at is not None
            or str(module.title_field_id) != title_id
            or str(field.id) != field_id
            or str(field.module_id) != module_id
            or field_id == title_id
            or field.required
            or field.is_deleted
            or field.deleted_at is not None
            or field.type.value != "long_text"
            or module.module_name != self.action.values["module_name"]
            or field.name != self.action.values["field_name"]
        ):
            raise SamplePhaseActionError(
                "Jobs source is not the owned active optional field", step="job_source_field"
            )
        self.state.update(
            module_id=module_id,
            field_id=field_id,
            title_id=title_id,
            field_name=field.name,
            name="Jobs retry " + uuid7().hex,
        )
        create = ReportCreate(
            module_id=module.id,
            name=self.state["name"],
            recipe={
                "version": 1,
                "fields": [{"field_id": field_id, "expected_type": "long_text"}],
                "filters": [],
                "logic": "and",
                "sorts": [],
                "group_by": None,
                "include_row_count": False,
            },
        )
        report = _model(
            ReportResponse,
            self.call(
                "POST",
                "/api/reports",
                "create_job_report",
                201,
                body=create.model_dump(mode="json"),
            ),
            "create_job_report",
        )
        if (
            report.module_id != create.module_id
            or report.name != create.name
            or report.recipe != create.recipe
            or report.is_deleted
        ):
            raise SamplePhaseActionError(
                "Jobs Report differs from its owned request", step="create_job_report"
            )
        self.state["report"] = report
        self.map("jobs_reports", str(report.id))
        current = _now_utc()
        due = current.replace(second=0, microsecond=0) + timedelta(minutes=2)
        schedule = _model(
            ScheduleResponse,
            self.call(
                "POST",
                f"/api/reports/{report.id}/schedule",
                "prepare_job_schedule",
                201,
                body={
                    "enabled": True,
                    "cadence": "daily",
                    "timezone_name": "UTC",
                    "local_time": due.strftime("%H:%M"),
                },
            ),
            "prepare_job_schedule",
        )
        if (
            schedule.report_id != report.id
            or not schedule.enabled
            or schedule.cadence != "daily"
            or schedule.timezone_name != "UTC"
            or schedule.local_time != due.strftime("%H:%M")
            or schedule.next_due_at is None
            or schedule.next_due_at != due
            or not current < schedule.next_due_at <= current + timedelta(minutes=3)
            or schedule.last_run is not None
        ):
            raise SamplePhaseActionError(
                "Jobs schedule is not near due in UTC", step="prepare_job_schedule"
            )
        self.state["schedule"] = schedule
        self.map("jobs_schedules", str(schedule.id))
        return {
            "prepared": True,
            "report": report.model_dump(mode="json"),
            "schedule": schedule.model_dump(mode="json"),
            "source": {
                "module_id": module_id,
                "field_id": field_id,
                "title_id": title_id,
                "field_name": field.name,
            },
        }

    def scan(self, phase: str, cycle: int, deadline: float) -> list[JobResponse]:
        matched: list[JobResponse] = []
        seen: set[str] = set()
        total: int | None = None
        report, schedule = self.state["report"], self.state["schedule"]
        link = f"/openview?section=reports&report={report.id}"
        for page_index in range(MAX_PAGES):
            step = f"{phase}_{cycle}_{page_index}"
            if _monotonic() >= deadline:
                raise SamplePhaseActionError("Jobs observation deadline exceeded", step=step)
            body = _read_json(
                self.call(
                    "GET",
                    "/api/jobs",
                    step,
                    params={
                        "kind": "report-run",
                        "limit": PAGE_LIMIT,
                        "offset": page_index * PAGE_LIMIT,
                    },
                ),
                step=step,
            )
            try:
                metadata = PaginationMetadata.model_validate(body.get("pagination"))
                rows = [JobResponse.model_validate(item) for item in body["items"]]
            except (ValidationError, KeyError, TypeError):
                raise SamplePhaseActionError("Jobs page shape is invalid", step=step) from None
            raw = body["pagination"]
            if (
                any(type(raw.get(key)) is not int for key in ("limit", "offset", "count", "total"))
                or metadata.limit != PAGE_LIMIT
                or metadata.offset != page_index * PAGE_LIMIT
                or metadata.count != len(rows)
                or metadata.count != min(PAGE_LIMIT, max(metadata.total - metadata.offset, 0))
                or metadata.has_more is not (metadata.offset + len(rows) < metadata.total)
                or metadata.total > PAGE_LIMIT * MAX_PAGES
                or (total is not None and metadata.total != total)
                or _monotonic() >= deadline
            ):
                raise SamplePhaseActionError("Jobs pagination or deadline differs", step=step)
            total = metadata.total
            self.pages.append({"step": step, **metadata.model_dump()})
            for row in rows:
                if row.kind != "report-run" or str(row.id) in seen:
                    raise SamplePhaseActionError("Jobs page kind or identity differs", step=step)
                seen.add(str(row.id))
                if row.subject_link == link or row.subject_label == report.name:
                    if (
                        row.subject_link != link
                        or row.subject_label != report.name
                        or row.scheduled_for != schedule.next_due_at
                    ):
                        raise SamplePhaseActionError(
                            "Jobs ownership or occurrence differs", step=step
                        )
                    matched.append(row)
            if not metadata.has_more:
                if len(matched) > 1:
                    raise SamplePhaseActionError(
                        "Jobs occurrence ownership is ambiguous", step=step
                    )
                return matched
        raise SamplePhaseActionError("Jobs page bound exceeded", step=phase)

    def poll(self, target: str, seconds: float) -> JobResponse:
        deadline, cycle = _monotonic() + seconds, 0
        while _monotonic() < deadline:
            rows = self.scan("poll_job_" + target, cycle, deadline)
            if rows:
                row = rows[0]
                expected_id = self.context.runtime_mappings.get("jobs_work", {}).get(CONTROL_KEY)
                if expected_id is not None and str(row.id) != expected_id:
                    raise SamplePhaseActionError(
                        "Observed job changed identity", step="poll_job_" + target
                    )
                if row.state == target:
                    return row
                if row.state not in {"pending", "running"}:
                    raise SamplePhaseActionError(
                        "Job did not reach the intended outcome", step="poll_job_" + target
                    )
            _sleep(POLL_SECONDS)
            cycle += 1
        raise SamplePhaseActionError("Jobs observation timed out", step="poll_job_" + target)

    def summary(self, state: str, row: JobResponse) -> ScheduleResponse:
        step = "job_schedule_" + state
        schedule = _model(
            ScheduleResponse,
            self.call("GET", f"/api/reports/{self.state['report'].id}/schedule", step),
            step,
        )
        last = schedule.last_run
        if (
            schedule.id != self.state["schedule"].id
            or schedule.report_id != self.state["report"].id
            or last is None
            or last.state != state
            or last.finished_at is None
            or row.last_attempt_at is None
            or last.finished_at.tzinfo is None
            or row.last_attempt_at.tzinfo is None
            or last.finished_at < row.last_attempt_at
            or last.failure_label != row.failure_label
        ):
            raise SamplePhaseActionError(
                "Job completion summary is unrecorded or mismatched", step=step
            )
        return schedule

    def observe(self) -> dict[str, object]:
        row = self.poll("failed", FAILURE_SECONDS)
        if row.attempts != 5 or row.failure_code != "attempts_exhausted" or not row.can_retry:
            raise SamplePhaseActionError(
                "Owned job did not exhaust its five normal attempts", step="poll_job_failed"
            )
        schedule = self.summary("failed", row)
        self.state["failed"] = row
        self.map("jobs_work", str(row.id))
        return {
            "failed": True,
            "job": row.model_dump(mode="json"),
            "schedule": schedule.model_dump(mode="json"),
            "pages": self.pages,
        }

    def recover(self) -> dict[str, object]:
        old: JobResponse = self.state["failed"]
        report: ReportResponse = self.state["report"]
        retry = _model(
            JobResponse,
            self.call("POST", f"/api/jobs/report-run/{old.id}/retry", "retry_owned_job"),
            "retry_owned_job",
        )
        if (
            retry.id != old.id
            or retry.kind != old.kind
            or retry.subject_link != old.subject_link
            or retry.subject_label != old.subject_label
            or retry.scheduled_for != old.scheduled_for
            or retry.state != "pending"
            or retry.attempts != 0
            or retry.failure_code is not None
            or retry.failure_label is not None
            or retry.last_attempt_at != old.last_attempt_at
            or retry.next_attempt_at is None
            or retry.can_retry
        ):
            raise SamplePhaseActionError(
                "Retry did not reset the same owned occurrence", step="retry_owned_job"
            )
        success = self.poll("succeeded", RECOVERY_SECONDS)
        if (
            success.attempts != 1
            or success.failure_code is not None
            or success.failure_label is not None
        ):
            raise SamplePhaseActionError(
                "Owned retry did not recover normally", step="poll_job_succeeded"
            )
        summary = self.summary("succeeded", success)
        from operations.sample.controls.jobs_report import dispose_owned_report, read_owned_output

        run = read_owned_output(self.call, report, self.state["field_name"])
        self.map("jobs_runs", str(run.id))
        self.state.update(retry=retry, success=success, run=run, recovered_schedule=summary)
        operation_id = dispose_owned_report(self.call, report, summary, self.context.admin_password)
        if self.scan("purged_job_absence", 0, _monotonic() + 30):
            raise SamplePhaseActionError("Purged report job remains", step="purged_job_absence")
        return {
            "retried": True,
            "recovered": True,
            "purged": True,
            "retry": retry.model_dump(mode="json"),
            "success": success.model_dump(mode="json"),
            "schedule": summary.model_dump(mode="json"),
            "run": run.model_dump(mode="json"),
            "purge_operation_id": operation_id,
            "pages": self.pages,
        }


def execute_job_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action not in plan_job_controls(dataset):
        raise SamplePhaseActionError("Jobs control differs from its pack plan", step=action.key)
    journey = _Journey(action, context, on_substep)
    operation = action.values["operation"]
    result = (
        journey.prepare()
        if operation == OPERATIONS[0]
        else journey.observe()
        if operation == OPERATIONS[1]
        else journey.recover()
    )
    return _result(action, context, journey.evidence, journey.mappings, extra=result)
