"""Independent HTTP state machine composed with the existing owned lifecycle wire."""

import copy
import csv
import io
import json
from datetime import UTC, datetime, time, timedelta
from uuid import uuid4

import httpx

from tests.operations.sample.controls.sample_lifecycle_wire import _LifecycleWire
from tests.operations.sample.controls.test_sample_control_sandbox import ADMIN_ID, _login_response


class Clock:
    def __init__(self):
        self.elapsed = 0.0
        self.base = datetime(2026, 10, 3, 12, 1, 10, tzinfo=UTC)

    def now(self):
        return self.base + timedelta(seconds=self.elapsed)

    def monotonic(self):
        return self.elapsed

    def sleep(self, seconds):
        self.elapsed += seconds


class JobsWire:
    def __init__(self, dataset, fault="none"):
        self.dataset, self.fault, self.clock = dataset, fault, Clock()
        versions = {
            key: {"id": str(uuid4()), "kind": kind}
            for key, kind in (
                ("initial", "published"),
                ("checkpoint", "checkpoint"),
                ("published", "published"),
            )
        }
        self.lifecycle = _LifecycleWire(dataset, versions, lambda: 12, "none")
        self.lifecycle.document, self.lifecycle.revision = copy.deepcopy(dataset.document), 12
        self.report = self.schedule = self.job = None
        self.finished_at = self.run = None
        self.requests, self.retry_calls, self.purge_calls = [], 0, 0
        self.archived = self.purged = False
        self.decoys = [str(uuid4()) for _ in range(101)]
        self.job_id, self.run_id = str(uuid4()), str(uuid4())
        self.challenge = str(uuid4())

    def instant(self):
        return self.clock.now().isoformat().replace("+00:00", "Z")

    def page(self, request, items):
        limit = int(request.url.params.get("limit", 25))
        offset = int(request.url.params.get("offset", 0))
        rows = items[offset : offset + limit]
        page = {
            "limit": limit,
            "offset": offset,
            "count": len(rows),
            "total": len(items),
            "has_more": offset + len(rows) < len(items),
        }
        if self.fault == "bad_pagination" and offset:
            page["count"] += 1
        if self.fault == "changing_total" and offset:
            page["total"] += 1
        return httpx.Response(200, json={"items": rows, "pagination": page})

    def handle(self, request):
        self.requests.append(request)
        response = _login_response(request) or self.request(request)
        if response is None:
            response = self.lifecycle.handle(request)
        if response is None:
            raise AssertionError("Unexpected synthetic Jobs route: " + request.url.path)
        response.headers.setdefault("X-Request-ID", str(uuid4()))
        response.headers.setdefault("Cache-Control", "no-store")
        if self.fault == "missing_request_id" and request.url.path == "/api/jobs":
            del response.headers["X-Request-ID"]
        return response

    def field(self):
        return next(row for row in self.lifecycle.live.values() if row.get("type") == "long_text")

    def advance(self):
        if self.job is None and self.clock.now() >= datetime.fromisoformat(
            self.schedule["next_due_at"]
        ):
            self.job = {
                "kind": "report-run",
                "id": self.job_id,
                "subject_label": self.report["name"],
                "subject_link": f"/openview?section=reports&report={self.report['id']}",
                "state": "pending",
                "scheduled_for": self.schedule["next_due_at"],
                "last_attempt_at": None,
                "next_attempt_at": self.schedule["next_due_at"],
                "attempts": 0,
                "failure_code": None,
                "failure_label": None,
                "can_retry": False,
            }
            self.schedule["next_due_at"] = (
                datetime.fromisoformat(self.schedule["next_due_at"]) + timedelta(days=1)
            ).isoformat()
        if self.job is None or self.job["state"] != "pending":
            return
        if self.fault in {"failure_timeout", "recovery_timeout"} and (
            self.fault == "failure_timeout" or self.retry_calls
        ):
            return
        if self.clock.now() < datetime.fromisoformat(self.job["next_attempt_at"]):
            return
        self.job["last_attempt_at"], self.job["attempts"] = self.instant(), self.job["attempts"] + 1
        if self.field()["is_deleted"]:
            if self.fault == "canceled":
                self.job.update(
                    state="canceled", failure_code="source_unavailable", can_retry=False
                )
            elif self.fault == "premature_success":
                self.job.update(state="succeeded", failure_code=None, can_retry=False)
            elif self.job["attempts"] == 5:
                self.job.update(state="failed", failure_code="attempts_exhausted", can_retry=True)
                self.job["failure_label"] = "The job failed after five attempts."
                self.finished_at = self.instant()
                if self.fault == "wrong_attempts":
                    self.job["attempts"] = 4
            else:
                self.job.update(
                    failure_code="run_failed",
                    failure_label="The report run failed. An automatic retry is pending.",
                )
                delays = (2, 4, 8, 16)
                self.job["next_attempt_at"] = (
                    self.clock.now() + timedelta(seconds=delays[self.job["attempts"] - 1])
                ).isoformat()
        else:
            self.job.update(
                state="succeeded", failure_code=None, failure_label=None, can_retry=False
            )
            self.finished_at = self.instant()
            self.run = {
                "id": self.run_id,
                "report_id": self.report["id"],
                "recipe_revision": 1,
                "row_count": 0,
                "headings": [self.field()["name"]],
                "created_at": self.instant(),
            }
            if self.fault == "wrong_run":
                self.run["report_id"] = str(uuid4())
        if self.job["state"] in {"failed", "succeeded", "canceled"}:
            self.job["next_attempt_at"] = None

    def impact(self):
        return {
            "target_type": "report",
            "target_id": self.report["id"],
            "operation": "purge",
            "actor_id": ADMIN_ID,
            "rows": [],
            "external_impacts": [],
            "key_strips": [],
            "blockers": [],
            "impact_digest": "b" * 64,
        }

    def request(self, request):
        path, method = request.url.path, request.method
        body = json.loads(request.content) if request.content else None
        if path == "/api/reports" and method == "POST":
            assert self.report is None and not self.field()["is_deleted"]
            module = next(row for row in self.lifecycle.live.values() if row["kind"] == "module")
            assert body["module_id"] == module["id"]
            assert body["recipe"]["fields"] == [
                {"field_id": self.field()["id"], "expected_type": "long_text"}
            ]
            self.report = {
                "id": str(uuid4()),
                **body,
                "subtitle": None,
                "revision": 1,
                "is_deleted": False,
                "created_at": self.instant(),
                "updated_at": self.instant(),
            }
            if self.fault == "wrong_report":
                self.report["module_id"] = str(uuid4())
            return httpx.Response(201, json=self.report)
        if self.report is None:
            return None
        root = f"/api/reports/{self.report['id']}"
        if path == root and method == "GET":
            return (
                httpx.Response(404, json={"detail": "Report not found"})
                if self.purged
                else httpx.Response(200, json=self.report)
            )
        if path == root + "/schedule":
            if method == "POST":
                assert not self.field()["is_deleted"] and body["enabled"] is True
                due = datetime.combine(
                    self.clock.now().date(), time.fromisoformat(body["local_time"]), UTC
                )
                if due <= self.clock.now():
                    due += timedelta(days=1)
                if self.fault == "far_due":
                    due += timedelta(days=1)
                self.schedule = {
                    "id": str(uuid4()),
                    "report_id": self.report["id"],
                    "revision": 1,
                    **body,
                    "weekday": None,
                    "month_day": None,
                    "next_due_at": due.isoformat(),
                    "last_run": None,
                    "created_at": self.instant(),
                    "updated_at": self.instant(),
                }
                return httpx.Response(201, json=self.schedule)
            if method == "PATCH":
                assert self.job["state"] == "succeeded" and body == {
                    "revision": 1,
                    "enabled": False,
                }
                self.schedule.update(enabled=False, revision=2, next_due_at=None)
            snapshot = copy.deepcopy(self.schedule)
            if self.job is not None:
                snapshot["last_run"] = {
                    "state": self.job["state"],
                    "finished_at": self.finished_at,
                    "failure_label": self.job["failure_label"],
                }
                if self.fault == "missing_finished":
                    snapshot["last_run"]["finished_at"] = None
            return httpx.Response(200, json=snapshot)
        if path == "/api/jobs":
            assert request.url.params.get("kind") == "report-run"
            if int(request.url.params.get("offset", 0)) == 0 and not self.purged:
                self.advance()
            decoys = [
                {
                    "kind": "report-run",
                    "id": identifier,
                    "subject_label": "Other Report",
                    "subject_link": f"/openview?section=reports&report={identifier}",
                    "state": "failed",
                    "scheduled_for": "2025-01-01T00:00:00Z",
                    "last_attempt_at": None,
                    "next_attempt_at": None,
                    "attempts": 5,
                    "failure_code": "attempts_exhausted",
                    "failure_label": "The job failed after five attempts.",
                    "can_retry": True,
                }
                for identifier in self.decoys
            ]
            owned = [] if self.job is None or self.purged else [copy.deepcopy(self.job)]
            if owned and self.fault == "wrong_ownership":
                owned[0]["subject_link"] = decoys[0]["subject_link"]
            if owned and self.fault == "duplicate_owned":
                owned.append({**owned[0], "id": str(uuid4())})
            # Newly failed work sorts first; pending work follows the failed occurrences.
            items = owned + decoys if owned and owned[0]["state"] == "failed" else decoys + owned
            return self.page(request, items)
        if path == f"/api/jobs/report-run/{self.job_id}/retry":
            assert (
                method == "POST"
                and self.job["state"] == "failed"
                and not self.field()["is_deleted"]
            )
            self.retry_calls += 1
            self.job.update(
                state="pending",
                attempts=0,
                failure_code=None,
                failure_label=None,
                can_retry=False,
                next_attempt_at=self.instant(),
            )
            self.finished_at = None
            if self.fault == "retry_unknown":
                return httpx.Response(503, json={"detail": "unavailable"})
            if self.fault == "wrong_retry_id":
                return httpx.Response(200, json={**self.job, "id": str(uuid4())})
            return httpx.Response(200, json=self.job)
        if path == root + "/runs":
            return self.page(request, [] if self.run is None else [self.run])
        if path == root + f"/runs/{self.run_id}":
            return httpx.Response(200, json=self.run)
        if path == root + f"/runs/{self.run_id}/csv":
            output = io.StringIO()
            csv.writer(output).writerow(self.run["headings"])
            return httpx.Response(
                200,
                content=output.getvalue().encode(),
                headers={
                    "Content-Type": "text/csv; charset=utf-8",
                    "Content-Disposition": f'attachment; filename="report-{self.run_id}.csv"',
                    "X-Content-Type-Options": "nosniff",
                },
            )
        if path == root and method == "DELETE":
            assert self.schedule["enabled"] is False and request.url.params["revision"] == "1"
            self.archived = self.report["is_deleted"] = True
            self.report["revision"] = 2
            return httpx.Response(204)
        if path == root + "/purge/preview":
            assert self.archived and method == "POST"
            impact = self.impact()
            if self.fault == "wrong_purge_target":
                impact["target_id"] = str(uuid4())
            return httpx.Response(
                200,
                json={
                    "impact": impact,
                    "token": self.challenge,
                    "confirmation_name": self.report["name"],
                    "expires_at": "2099-01-01T00:00:00Z",
                    "last_successful_backup_at": None,
                },
            )
        if path == root + "/purge":
            assert self.archived and body == {
                "token": self.challenge,
                "confirmation_name": self.report["name"],
                "password": "fixture-admin-password",
            }
            self.purge_calls += 1
            self.purged = self.fault != "retained_report"
            return httpx.Response(200, json={"operation_id": str(uuid4()), "impact": self.impact()})
        return None
