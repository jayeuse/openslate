"""Owned Jobs failure/retry API journeys; no live scheduler or direct database setup."""

import copy
from dataclasses import replace

import pytest

from operations.sample.controls.actions import execute_control_action, plan_controls
from operations.sample.phases.actions import SamplePhaseActionError
from tests.operations.sample.controls.sample_jobs_wire import JobsWire
from tests.operations.sample.controls.test_sample_control_sandbox import _context, _dataset

JOB_OPERATIONS = ("jobs_prepare", "jobs_observe_failure", "jobs_retry_recover_cleanup")


@pytest.mark.parametrize("pack_key", ("harbor", "school", "neutral"))
def test_jobs_plan_wraps_only_the_owned_optional_field_lifecycle(pack_key: str):
    dataset = _dataset("school" if pack_key == "school" else "harbor")
    if pack_key == "neutral":
        dataset = replace(
            dataset,
            organization=replace(
                dataset.organization,
                identity=replace(dataset.organization.identity, key="other-company"),
            ),
        )
    before = copy.deepcopy(dataset.document)
    actions = plan_controls(dataset)
    jobs = [action for action in actions if action.values["operation"] in JOB_OPERATIONS]
    assert [action.values["operation"] for action in jobs] == list(JOB_OPERATIONS)
    operations = [action.values["operation"] for action in actions]
    assert (
        operations.index("prepare_lifecycle_bindings")
        < operations.index(JOB_OPERATIONS[0])
        < operations.index("close_field")
        < operations.index(JOB_OPERATIONS[1])
        < operations.index("reopen_field")
        < operations.index(JOB_OPERATIONS[2])
        < operations.index("purge_field")
    )
    assert all(action.actor_key == "admin" and action.kind == "jobs_controls" for action in jobs)
    assert dataset.document == before


def _journey(tmp_path, monkeypatch, pack_key="harbor", fault="none"):
    import operations.sample.controls.jobs as jobs

    dataset = _dataset("school" if pack_key == "school" else "harbor")
    if pack_key == "neutral":
        dataset = replace(
            dataset,
            organization=replace(
                dataset.organization,
                identity=replace(dataset.organization.identity, key="other-company"),
            ),
        )
    wire = JobsWire(dataset, fault)
    context = _context(tmp_path, wire.handle)
    monkeypatch.setattr(jobs, "_now_utc", wire.clock.now, raising=False)
    monkeypatch.setattr(jobs, "_monotonic", wire.clock.monotonic, raising=False)
    monkeypatch.setattr(jobs, "_sleep", wire.clock.sleep, raising=False)
    selected = {
        "prepare_lifecycle_bindings",
        "close_field",
        "reopen_field",
        "purge_field",
        *JOB_OPERATIONS,
    }
    actions = [
        action for action in plan_controls(dataset) if action.values["operation"] in selected
    ]
    return dataset, wire, context, actions


@pytest.mark.parametrize("pack_key", ("harbor", "school", "neutral"))
def test_jobs_journey_pages_owned_failure_retries_and_purges_before_the_field(
    tmp_path,
    monkeypatch,
    pack_key,
):
    dataset, wire, context, actions = _journey(tmp_path, monkeypatch, pack_key)
    document = copy.deepcopy(dataset.document)
    results = []
    with context.clients["admin"]:
        for action in actions:
            result = execute_control_action(action, dataset, context)
            if action.kind == "jobs_controls":
                results.append(result)
    assert len(results) == 3
    assert results[1]["job"]["id"] == wire.job_id
    assert results[1]["job"]["attempts"] == 5
    assert results[2]["retry"]["id"] == wire.job_id
    assert results[2]["success"]["state"] == "succeeded"
    assert results[2]["run"]["row_count"] == 0
    assert wire.retry_calls == wire.purge_calls == 1
    field_id = context.runtime_mappings["sandbox_lifecycle"]["field"]
    assert wire.purged and field_id not in wire.lifecycle.live
    assert any(
        request.url.path == "/api/jobs" and request.url.params.get("offset") == "100"
        for request in wire.requests
    )
    paths = [request.url.path for request in wire.requests if request.method == "POST"]
    assert paths.index(f"/api/reports/{wire.report['id']}/purge") < paths.index(
        f"/api/fields/{field_id}/purge"
    )
    journal = (tmp_path / "requests.jsonl").read_text()
    assert "/api/jobs/{kind}/{job_id}/retry" in journal
    assert "fixture-admin-password" not in journal and wire.challenge not in journal
    assert dataset.document == document


@pytest.mark.parametrize(
    "fault",
    (
        "wrong_report",
        "far_due",
        "bad_pagination",
        "changing_total",
        "missing_request_id",
        "wrong_ownership",
        "duplicate_owned",
        "canceled",
        "premature_success",
        "wrong_attempts",
        "failure_timeout",
        "wrong_retry_id",
        "retry_unknown",
        "recovery_timeout",
        "wrong_run",
        "missing_finished",
        "wrong_purge_target",
        "retained_report",
    ),
)
def test_jobs_faults_stop_without_selecting_another_job_or_replaying_writes(
    tmp_path,
    monkeypatch,
    fault,
):
    dataset, wire, context, actions = _journey(tmp_path, monkeypatch, fault=fault)
    with context.clients["admin"], pytest.raises(SamplePhaseActionError) as caught:
        for action in actions:
            execute_control_action(action, dataset, context)
    assert caught.value.step != "control:jobs_prepare", "Failure must reach the injected boundary"
    assert wire.retry_calls <= 1 and wire.purge_calls <= 1
    if fault not in {"retained_report"}:
        assert wire.purge_calls == 0
    assert not any(
        request.method == "POST"
        and request.url.path.startswith("/api/fields/")
        and request.url.path.endswith("/purge")
        for request in wire.requests
    )
    if fault == "retry_unknown":
        retry_index = next(
            index
            for index, request in enumerate(wire.requests)
            if request.method == "POST" and request.url.path.startswith("/api/jobs/")
        )
        assert any(
            request.method == "GET" and request.url.path == "/api/jobs"
            for request in wire.requests[retry_index + 1 :]
        )
    if fault in {"wrong_purge_target", "retained_report"}:
        run_mapping = context.runtime_mappings.get("jobs_runs", {}).get("control:jobs_retry")
        assert run_mapping == wire.run_id


def _completed(tmp_path, monkeypatch):
    dataset, wire, context, actions = _journey(tmp_path, monkeypatch)
    pairs = []
    for action in actions:
        result = execute_control_action(action, dataset, context)
        if action.kind == "jobs_controls":
            pairs.append((action, result))
    return dataset, wire, context, pairs


def test_jobs_actual_transport_receipts_are_admitted_by_control_verification(tmp_path, monkeypatch):
    from dataclasses import asdict

    from operations.sample.controls.request_verification import verify_request_evidence

    dataset, wire, context, pairs = _completed(tmp_path, monkeypatch)
    manifest = {
        "mappings": context.runtime_mappings,
        "control_plan": [asdict(action) for action, _ in pairs],
        "control_results": [result for _, result in pairs],
    }
    seen, observed, issues = set(), {"control_requests_verified": 0}, []
    with context.clients["admin"]:
        for action, result in pairs:
            verify_request_evidence(
                dataset,
                manifest,
                action,
                result,
                {},
                context.user_ids["admin"],
                seen,
                observed,
                issues,
            )
    assert issues == []
    assert observed["control_requests_verified"] == sum(
        len(result["request_evidence"]) for _, result in pairs
    )
    assert wire.retry_calls == 1


@pytest.mark.parametrize(
    "fault",
    ("job_id", "missing_reads", "bad_request_id", "wrong_target", "reset", "pages", "run", "purge"),
)
def test_job_control_proof_rejects_tampered_transport_or_end_state(tmp_path, monkeypatch, fault):
    from dataclasses import asdict

    from operations.sample.controls.request_verification import verify_request_evidence

    dataset, _, context, pairs = _completed(tmp_path, monkeypatch)
    action, result = pairs[1] if fault in {"job_id", "pages"} else pairs[2]
    result = copy.deepcopy(result)
    if fault == "job_id":
        result["job"]["id"] = result["job"]["subject_link"].split("=")[-1]
    elif fault == "missing_reads":
        result["request_evidence"] = [
            row for row in result["request_evidence"] if row["method"] != "GET"
        ]
    elif fault == "bad_request_id":
        result["request_evidence"][0]["request_id"] = "unbound"
    elif fault == "wrong_target":
        result["request_evidence"][0]["path"] = (
            "/api/jobs/report-run/00000000-0000-0000-0000-000000000000/retry"
        )
    elif fault == "reset":
        result["retry"]["attempts"] = 5
    elif fault == "pages":
        result["pages"][0]["offset"] = 1
    elif fault == "run":
        result["run"]["report_id"] = "00000000-0000-0000-0000-000000000000"
    else:
        result["purged"] = False
    manifest = {
        "mappings": context.runtime_mappings,
        "control_plan": [asdict(item) for item, _ in pairs],
        "control_results": [value for _, value in pairs],
    }
    issues = []
    with context.clients["admin"]:
        verify_request_evidence(
            dataset,
            manifest,
            action,
            result,
            {},
            context.user_ids["admin"],
            set(),
            {"control_requests_verified": 0},
            issues,
        )
    assert issues, "Proof must fail independently of the recorded outcome boolean"


@pytest.mark.parametrize(
    "fault",
    (
        "underfilled",
        "duplicate_ids",
        "wrong_kind",
        "string_metadata",
        "boolean_metadata",
        "float_metadata",
    ),
)
def test_final_jobs_scan_refuses_incomplete_or_invalid_pages(tmp_path, monkeypatch, fault):
    from dataclasses import asdict

    import httpx

    from operations.sample.controls.jobs_verification import verify_jobs_controls

    dataset, wire, context, pairs = _completed(tmp_path, monkeypatch)
    manifest = {
        "mappings": context.runtime_mappings,
        "control_plan": [asdict(action) for action, _ in pairs],
        "control_results": [result for _, result in pairs],
    }
    original_request = wire.request
    first_id = wire.decoys[0]

    def final_request(request):
        response = original_request(request)
        if request.method != "GET" or request.url.path != "/api/jobs":
            return response
        body = response.json()
        page, rows = body["pagination"], body["items"]
        if fault == "underfilled":
            rows = []
            page.update(count=0, total=1, has_more=page["offset"] == 0)
        elif fault == "duplicate_ids" and page["offset"]:
            rows[0]["id"] = first_id
        elif fault == "wrong_kind":
            rows[0]["kind"] = "backup"
        elif fault == "string_metadata":
            for key in ("limit", "offset", "count", "total"):
                page[key] = str(page[key])
        elif fault == "boolean_metadata":
            rows = rows[:1]
            page.update(count=True, total=True, has_more=False)
        elif fault == "float_metadata":
            for key in ("limit", "offset", "count", "total"):
                page[key] = float(page[key])
        return httpx.Response(200, json={"items": rows, "pagination": page})

    # Injection begins only after the actual completed transport receipts exist.
    monkeypatch.setattr(wire, "request", final_request)
    with context.clients["admin"]:
        observed, issues = verify_jobs_controls(
            context.clients["admin"], dataset, manifest, context.user_ids["admin"]
        )
    assert issues and observed == {}, {
        "fault": fault,
        "observed": observed,
        "issues": issues,
    }
