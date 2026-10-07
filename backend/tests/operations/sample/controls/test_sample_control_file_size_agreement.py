"""Normalized logo sizes must agree across the real API response boundaries."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from operations.sample.controls.files import FILE_NAMES, execute_file_control, plan_file_controls
from operations.sample.controls.files_verification import verify_file_controls
from operations.sample.phases.actions import SamplePhaseActionError
from tests.operations.sample.controls.test_sample_control_files import (
    ADMIN_ID,
    FileWire,
    _context,
    _dataset,
)


class LogoSizeWire(FileWire):
    """Change one logo response only; all bytes and other responses stay faithful."""

    def __init__(self, dataset, boundary: str) -> None:
        super().__init__(dataset)
        self.boundary = boundary
        self.final_phase = False
        self.fault_hits = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        response = super().__call__(request)
        path = request.url.path
        if response.status_code != 200 or not path.startswith("/api/files"):
            return response
        if self.boundary.startswith("final_") is not self.final_phase:
            return response
        stage = self.boundary.removeprefix("final_")
        matches = (
            (stage == "upload" and request.method == "PUT")
            or (stage == "list" and request.method == "GET" and path == "/api/files")
            or (stage == "detail" and request.method == "GET" and path.count("/") == 3)
        )
        if not matches or self.fault_hits:
            return response
        body = response.json()
        rows = body.get("items", []) if stage == "list" else [body]
        for row in rows:
            if row.get("filename") == FILE_NAMES["logo_primary"]:
                row["actual_size"] += 1
                self.fault_hits += 1
                return httpx.Response(response.status_code, headers=response.headers, json=body)
        return response


@pytest.mark.parametrize("boundary", ("upload", "list"))
def test_logo_size_mismatch_rejects_the_journey_before_binding(
    tmp_path: Path, boundary: str
) -> None:
    dataset = _dataset()
    wire = LogoSizeWire(dataset, boundary)
    context = _context(tmp_path, dataset, wire)
    rejection = None
    try:
        execute_file_control(plan_file_controls(dataset)[2], dataset, context)
    except SamplePhaseActionError as error:
        rejection = error
    assert wire.fault_hits == 1, "The logo-specific response mismatch must actually be reached"
    assert rejection is not None, "A differing normalized size must not complete the journey"
    assert not any(r.method == "PATCH" for r in wire.seen)


@pytest.mark.parametrize("boundary", ("final_detail", "final_list"))
def test_final_logo_detail_and_inventory_sizes_must_agree(tmp_path: Path, boundary: str) -> None:
    dataset = _dataset()
    wire = LogoSizeWire(dataset, boundary)
    context = _context(tmp_path, dataset, wire)
    results = [
        execute_file_control(action, dataset, context) for action in plan_file_controls(dataset)
    ]
    assert all(row["outcome"] == "completed" for row in results)
    wire.final_phase = True
    manifest = {"mappings": context.runtime_mappings, "control_results": results}
    counts, issues = verify_file_controls(
        context.clients["admin"], dataset, manifest, admin_id=ADMIN_ID
    )
    assert wire.fault_hits == 1, "The final logo-only metadata mismatch must be exercised"
    assert issues, "Purged logo completion requires agreeing independent metadata readbacks"
    assert counts["logos_purged"] == 0
