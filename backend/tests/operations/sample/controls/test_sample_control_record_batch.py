"""Actual Platform batch-update requests, partial outcomes and restoration."""

import copy
import json
from datetime import datetime
from uuid import uuid4

import httpx
import pytest

from operations.sample.client import SampleWriteOutcomeUnknown
from operations.sample.controls.actions import execute_control_action, plan_controls
from operations.sample.controls.platform import OPERATIONS
from operations.sample.controls.sandbox import OPERATIONS as LIFECYCLE_OPERATIONS
from operations.sample.phases.actions import SamplePhaseActionError
from tests.operations.sample.controls.sample_platform_wire import PlatformWire
from tests.operations.sample.controls.sample_record_batch import batch_response
from tests.operations.sample.controls.test_sample_control_sandbox import _context, _dataset

BATCH_PATH = "/api/records/batch-update"


class BatchWire(PlatformWire):
    def __init__(self, dataset, fault="none"):
        super().__init__(dataset)
        self.batch_fault = fault
        self.batches, self.batch_results, self.batch_states = [], [], []

    def request(self, request):
        if request.url.path != BATCH_PATH:
            response = super().request(request)
            if (
                self.batches
                and request.method == "GET"
                and response.status_code == 200
                and request.url.path == f"/api/records/{self.created[0]}"
                and self.batch_fault == "readback_data"
            ):
                body = response.json()
                body["data"][str(self.fields()[1].id)] = "Unconfirmed readback"
                return httpx.Response(200, json=body)
            return response
        body = json.loads(request.content)
        self.batches.append(copy.deepcopy(body))
        self.batch_states.append(copy.deepcopy(self.records))
        index = len(self.batches)
        if self.batch_fault in {"denied", "unavailable"}:
            return httpx.Response(
                403 if self.batch_fault == "denied" else 503, json={"detail": "private-canary"}
            )
        response = batch_response(self, request)
        result = response.json()
        if index == 1:
            if self.batch_fault == "malformed":
                result = {"results": "malformed"}
            elif self.batch_fault == "missing":
                result["results"].pop()
            elif self.batch_fault == "duplicate":
                result["results"][1] = copy.deepcopy(result["results"][0])
            elif self.batch_fault == "foreign_result":
                result["results"][0]["record_id"] = str(uuid4())
            elif self.batch_fault == "foreign_record":
                result["results"][0]["record"]["id"] = str(uuid4())
            elif self.batch_fault == "wrong_module":
                result["results"][0]["record"]["module_id"] = str(uuid4())
            elif self.batch_fault == "non_target":
                result["results"][0]["record"]["data"][str(self.fields()[0].id)] = "Changed title"
            elif self.batch_fault == "unchanged_revision":
                result["results"][0]["record"]["updated_at"] = self.batch_states[0][
                    self.created[0]
                ]["updated_at"]
            elif self.batch_fault == "naive_revision":
                result["results"][0]["record"]["updated_at"] = "2026-10-03T00:00:01"
            elif self.batch_fault == "unexpected_status":
                result["results"][0] = {"status": "forbidden", "record_id": self.created[0]}
            elif self.batch_fault == "extra_shape":
                result["unexpected"] = True
            elif self.batch_fault == "cache":
                response.headers["Cache-Control"] = "public"
        elif index == 2:
            if self.batch_fault == "stale_as_updated":
                result["results"][0] = {
                    "status": "updated",
                    "record_id": self.created[0],
                    "record": self.record(self.created[0]),
                }
            elif self.batch_fault == "stale_changed":
                self.records[self.created[0]]["data"][str(self.fields()[1].id)] = (
                    "Stale item changed"
                )
        elif index == 3:
            if self.batch_fault == "restore_status":
                result["results"][1] = {"status": "stale", "record_id": self.created[1]}
            elif self.batch_fault == "restore_data":
                result["results"][1]["record"]["data"][str(self.fields()[1].id)] = "Not restored"
            elif self.batch_fault == "restore_state":
                self.records[self.created[1]]["data"][str(self.fields()[1].id)] = "Not restored"
        self.batch_results.append(copy.deepcopy(result))
        return httpx.Response(200, headers=response.headers, json=result)


def _execute(tmp_path, monkeypatch, wire):
    monkeypatch.setattr("operations.sample.controls.openview_purge._PURGE_POLL_SECONDS", 0)
    context = _context(tmp_path, wire.handle)
    wire.bind(context)
    actions = [
        action
        for action in plan_controls(wire.dataset)
        if action.values["operation"] in (*OPERATIONS, *LIFECYCLE_OPERATIONS)
    ]
    with context.clients["admin"]:
        for action in actions:
            result = execute_control_action(action, wire.dataset, context)
            if action.values["operation"] == OPERATIONS[2]:
                return result, context
    raise AssertionError("Export control was not planned")


@pytest.mark.parametrize("pack_key", ("harbor", "school"))
def test_batch_control_updates_partially_conflicts_and_restores_before_export_and_purge(
    tmp_path,
    monkeypatch,
    pack_key,
):
    wire = BatchWire(_dataset(pack_key))
    result, context = _execute(tmp_path, monkeypatch, wire)
    assert len(wire.batches) == 3
    assert result["outcome"] == "completed" and result["read_checks"] == 12
    fields = wire.fields()
    for body in wire.batches:
        assert set(body) == {"module_id", "items"}
        assert [item["record_id"] for item in body["items"]] == wire.created
        assert all(
            set(item) == {"record_id", "revision", "field_id", "value"} for item in body["items"]
        )
        assert all(item["field_id"] == str(fields[1].id) for item in body["items"])
    first, partial, restore = wire.batches
    assert partial["items"][0]["revision"] == first["items"][0]["revision"]
    assert partial["items"][1]["revision"] != first["items"][1]["revision"]
    assert [row["status"] for row in wire.batch_results[1]["results"]] == ["stale", "updated"]
    for index, identifier in enumerate(wire.created):
        original = wire.batch_states[0][identifier]
        assert datetime.fromisoformat(first["items"][index]["revision"]) == datetime.fromisoformat(
            original["updated_at"]
        )
        assert restore["items"][index]["value"] == original["data"][str(fields[1].id)]
        assert all(
            state[identifier]["data"][str(fields[0].id)] == original["data"][str(fields[0].id)]
            for state in wire.batch_states
        )
    assert wire.records == {} and wire.purges == 2
    assert {
        json.loads(request.content)["format"]
        for request in wire.requests
        if request.url.path == "/api/records/export"
    } == {"csv", "xlsx"}
    steps = [row["step"] for row in result["request_evidence"]]
    assert (
        steps.index("batch_restore_records")
        < steps.index("export_csv")
        < steps.index("export_xlsx")
    )
    assert {row["step"] for row in result["request_evidence"] if row["path"] == BATCH_PATH} == {
        "batch_update_records",
        "batch_partial_records",
        "batch_restore_records",
    }
    assert context.runtime_mappings["platform_records"] == dict(
        zip(("opening_review", "completion_review"), wire.created, strict=True)
    )
    journal = (tmp_path / "requests.jsonl").read_text()
    assert "fixture-admin-password" not in journal


@pytest.mark.parametrize(
    "fault",
    (
        "denied",
        "unavailable",
        "malformed",
        "missing",
        "duplicate",
        "foreign_result",
        "foreign_record",
        "wrong_module",
        "non_target",
        "unchanged_revision",
        "naive_revision",
        "unexpected_status",
        "extra_shape",
        "cache",
        "readback_data",
        "stale_as_updated",
        "stale_changed",
        "restore_status",
        "restore_data",
        "restore_state",
    ),
)
def test_batch_control_refuses_unconfirmed_outcomes_without_retry_or_purge(
    tmp_path,
    monkeypatch,
    fault,
):
    wire = BatchWire(_dataset("harbor"), fault)
    with pytest.raises((SamplePhaseActionError, SampleWriteOutcomeUnknown)) as caught:
        _execute(tmp_path, monkeypatch, wire)
    assert len(wire.batches) == (
        2
        if fault in {"stale_as_updated", "stale_changed"}
        else 3
        if fault.startswith("restore_")
        else 1
    )
    assert wire.purges == 0
    assert not any(
        request.method == "DELETE" and request.url.path.startswith("/api/records/")
        for request in wire.requests
    )
    if fault != "restore_state":
        assert not any(request.url.path == "/api/records/export" for request in wire.requests)
    assert "private-canary" not in str(caught.value)
