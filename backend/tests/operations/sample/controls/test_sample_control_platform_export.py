"""Platform CSV/XLSX exports against independent import receipts and verified cleanup."""

import copy
import json

import pytest

from operations.sample.client import SampleWriteOutcomeUnknown
from operations.sample.controls.actions import plan_controls
from operations.sample.controls.platform_verification import verify_platform_evidence
from operations.sample.phases.actions import SamplePhaseActionError
from tests.operations.sample.controls.test_sample_control_sandbox import (
    ADMIN_ID,
    _context,
    _dataset,
)


@pytest.mark.parametrize(
    "pack_key,fault",
    [
        ("school", "none"),
        *[
            ("harbor", value)
            for value in (
                "none",
                "preview_created",
                "bad_digest",
                "duplicate_ids",
                "wrong_row",
                "wrong_data",
                "import_503",
                "csv_count",
                "csv_content",
                "csv_mime",
                "csv_columns",
                "csv_ids",
                "csv_unsafe_filename",
                "csv_wrong_date",
                "csv_cache",
                "csv_nosniff",
                "csv_too_large",
                "csv_denied",
                "csv_unavailable",
                "xlsx_count",
                "xlsx_content",
                "xlsx_mime",
                "xlsx_columns",
                "xlsx_ids",
                "xlsx_unsafe_filename",
                "xlsx_wrong_date",
                "xlsx_cache",
                "xlsx_nosniff",
                "xlsx_too_large",
                "xlsx_denied",
                "xlsx_unavailable",
                "xlsx_malformed_zip",
                "xlsx_malformed_xml",
                "xlsx_formula",
                "xlsx_entities",
                "xlsx_large_xml",
                "xlsx_duplicate_member",
                "purge_blocker",
                "purge_remains",
                "search_kind",
                "search_private",
                "search_context",
                "search_page",
                "theme_owner",
                "theme_unsaved",
                "theme_restore",
                "appearance_lost",
            )
        ],
    ],
)
def test_platform_wire_imports_searches_exports_disposes_and_restores(
    tmp_path, monkeypatch, pack_key, fault
):
    import operations.sample.controls.openview_purge as frozen_helpers
    from operations.sample.controls.actions import execute_control_action
    from operations.sample.controls.platform import OPERATIONS
    from operations.sample.controls.sandbox import OPERATIONS as lifecycle_operations
    from tests.operations.sample.controls.sample_platform_wire import PlatformWire

    monkeypatch.setattr(frozen_helpers, "_PURGE_POLL_SECONDS", 0)
    dataset = _dataset(pack_key)
    original_theme = "system" if pack_key == "school" else "dark"
    wire = PlatformWire(dataset, fault, original_theme=original_theme)
    context = _context(tmp_path, wire.handle)
    wire.bind(context)
    selected = [
        row
        for row in plan_controls(dataset)
        if row.values["operation"] in (*OPERATIONS, *lifecycle_operations)
    ]
    results = []
    try:
        if fault != "none":
            with pytest.raises((SamplePhaseActionError, SampleWriteOutcomeUnknown)) as caught:
                for action in selected:
                    results.append(execute_control_action(action, dataset, context))
            assert getattr(caught.value, "step", None) != selected[1].key
            preference_steps = {
                "theme_owner": "read_original_theme",
                "theme_unsaved": "theme_changed_readback",
                "theme_restore": "theme_restore_readback",
                "appearance_lost": "toggle_theme",
            }
            if fault in preference_steps:
                assert caught.value.step == preference_steps[fault]
            if fault.startswith(("csv_", "xlsx_")):
                format = fault.partition("_")[0]
                if fault.endswith("_unavailable"):
                    assert isinstance(caught.value, SampleWriteOutcomeUnknown)
                    assert caught.value.status_code == 503
                else:
                    assert getattr(caught.value, "step", None) == f"export_{format}"
                exports = [r for r in wire.requests if r.url.path == "/api/records/export"]
                assert [json.loads(r.content)["format"] for r in exports] == (
                    ["csv"] if format == "csv" else ["csv", "xlsx"]
                )
                assert wire.purges == 0
                assert not any(
                    r.method == "DELETE" and r.url.path.startswith("/api/records/")
                    for r in wire.requests
                )
                assert "private-canary" not in str(caught.value)
            assert wire.commits <= 1
            if fault in {"preview_created", "bad_digest"}:
                assert wire.commits == 0
            if fault == "import_503":
                assert len([r for r in wire.requests if r.url.path == "/api/records/import"]) == 2
                from operations.sample.verification.route_coverage import read_route_evidence

                assert (
                    sum(read_route_evidence(tmp_path / "requests.jsonl")["failures_5xx"].values())
                    == 1
                )
            return
        for action in selected:
            results.append(execute_control_action(action, dataset, context))
        platform = [row for row in results if row["action_key"].startswith("control:platform:")]
        assert len(platform) == len(OPERATIONS) == 5
        assert wire.previews == wire.commits == 1 and wire.purges == 2
        assert len(wire.created) == len(set(wire.created)) == 2 and wire.records == {}
        assert wire.theme == wire.original_theme == original_theme
        assert wire.appearance == {"motion": "reduce", "keyboard_shortcuts": False}
        assert wire.lifecycle.document == dataset.document
        first_close = next(
            i for i, r in enumerate(wire.requests) if r.url.path.endswith("/close/preview")
        )
        assert sum(r.url.path.endswith("/purge") for r in wire.requests[:first_close]) == 2
        assert (
            sum(
                r.method == "GET"
                and r.url.path.startswith("/api/records/")
                and r.url.path.split("/")[-1] in wire.created
                for r in wire.requests[:first_close]
            )
            >= 4
        )
        assert (
            platform[0]["records_imported"]
            == platform[2]["records_exported"]
            == platform[2]["records_purged"]
            == 2
        )
        assert platform[1]["search_kinds_verified"] == 4 and platform[4]["theme_restored"] is True
        exports = [r for r in wire.requests if r.url.path == "/api/records/export"]
        bodies = [json.loads(r.content) for r in exports]
        assert [body["format"] for body in bodies] == ["csv", "xlsx"]
        for body in bodies:
            assert set(body) == {
                "module_id",
                "definition",
                "format",
                "include_record_id",
                "include_details",
            }
            assert body["include_record_id"] is True and body["include_details"] is False
        assert bodies[0]["module_id"] == bodies[1]["module_id"]
        assert bodies[0]["definition"] == bodies[1]["definition"]
        imported = json.loads(
            next(r.content for r in wire.requests if r.url.path == "/api/records/import")
        )
        assert [column["field_id"] for column in bodies[0]["definition"]["columns"]] == [
            row["field_id"] for row in imported["mapping"]
        ]
        export_action = next(row for row in selected if row.values["operation"] == OPERATIONS[2])
        manifest = {"mappings": copy.deepcopy(context.runtime_mappings)}
        issues = []
        verify_platform_evidence(
            dataset,
            manifest,
            export_action,
            platform[2],
            ADMIN_ID,
            set(),
            {"control_requests_verified": 0},
            issues,
        )
        assert issues == []
        missing_xlsx = {
            **platform[2],
            "request_evidence": [
                row for row in platform[2]["request_evidence"] if row["step"] != "export_xlsx"
            ],
        }
        verify_platform_evidence(
            dataset,
            manifest,
            export_action,
            missing_xlsx,
            ADMIN_ID,
            set(),
            {"control_requests_verified": 0},
            issues,
        )
        assert any("request steps" in issue.lower() for issue in issues)
        journal = (tmp_path / "requests.jsonl").read_text()
        assert "fixture-admin-password" not in journal
    finally:
        context.clients["admin"].close()
