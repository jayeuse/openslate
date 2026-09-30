from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from app.core.config.disposable_instance import PROVIDER_IMAGES
from app.core.config.instance import InstanceTarget
from operations import seed_sample_data as seed_operator
from operations.sample_client import SampleClient
from operations.sample_population_workflow import (
    SamplePopulationError as SampleWorkflowError,
)
from operations.sample_population_workflow import (
    build_record_payload,
    relationship_write,
)
from operations.sample_scenario import build_dataset
from operations.sample_verification import (
    SampleVerificationError,
    assert_pristine_baseline,
    assert_pristine_sandbox,
    assert_pristine_workspace,
    count_mismatches,
    failure_report,
    has_matching_audit,
    list_all_rows,
    named_invoice_issues,
    unique_rows_by_name,
)
from operations.seed_sample_data import (
    SampleOperationError,
    _assert_owned_mailpit,
    build_plan_summary,
)


def _workspace(**changes: object) -> dict[str, object]:
    return {
        "display_name": "OpenSlate",
        "legal_name": None,
        "description": None,
        "contact_email": None,
        "contact_phone": None,
        "postal_address": None,
        "logo_file_id": None,
        "timezone": "UTC",
        "locale": "en-US",
        "invitation_expiry_days": 7,
        "guest_duration_days": 30,
        "revision": 1,
        **changes,
    }


def _document(**changes: object) -> dict[str, object]:
    document: dict[str, object] = {
        "kind": "openslate-sandbox",
        "schemaVersion": 4,
        "design": {"departments": [], "modules": [], "relationships": [], "layout": {}},
        "triggers": [],
        "scenarios": [],
    }
    document.update(changes)
    return {"revision": 1, "document": document}


def test_pristine_baseline_rejects_partial_workspace_and_sandbox_changes() -> None:
    with pytest.raises(SampleVerificationError, match="workspace"):
        assert_pristine_workspace(_workspace(display_name="Harbor Operations Group"))

    with pytest.raises(SampleVerificationError, match="workspace"):
        assert_pristine_workspace(_workspace(revision=2))

    assert_pristine_workspace(_workspace())

    with pytest.raises(SampleVerificationError, match="Sandbox"):
        assert_pristine_sandbox(
            _document(
                design={
                    "departments": [{"id": "department-1", "name": "Sales"}],
                    "modules": [],
                    "relationships": [],
                    "layout": {},
                }
            )
        )

    with pytest.raises(SampleVerificationError, match="Sandbox"):
        assert_pristine_sandbox(_document(revision=2))

    assert_pristine_sandbox(_document())


def test_structure_mapping_refuses_ambiguous_names() -> None:
    rows = [
        {"id": "module-a", "module_name": "Invoices"},
        {"id": "module-b", "module_name": " invoices "},
    ]

    with pytest.raises(SampleVerificationError, match="ambiguous"):
        unique_rows_by_name(rows, name_key="module_name", entity="module")


def test_verify_reports_observed_count_mismatch() -> None:
    assert count_mismatches(
        {"records": 1_001, "relationships": 2_300},
        {"records": 1_000, "relationships": 2_300},
    ) == {"records": {"expected": 1_001, "observed": 1_000}}


def test_failure_report_marks_incomplete_without_serializing_exception_secrets() -> None:
    report = failure_report("records", RuntimeError("request leaked password=private-token"))

    assert report["status"] == "incomplete"
    assert report["stage"] == "records"
    assert report["error_type"] == "RuntimeError"
    assert "private-token" not in json.dumps(report)


def test_api_read_consumes_every_page_and_honors_the_full_server_total(tmp_path: Path) -> None:
    offsets: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        offset = int(request.url.params["offset"])
        offsets.append(offset)
        rows = [{"id": "row-1"}, {"id": "row-2"}] if offset == 0 else [{"id": "row-3"}]
        count = len(rows)
        return httpx.Response(
            200,
            json={
                "items": rows,
                "pagination": {
                    "limit": 2,
                    "offset": offset,
                    "count": count,
                    "total": 3,
                    "has_more": offset + count < 3,
                },
            },
        )

    with SampleClient(
        "http://api.example.test",
        "http://workspace.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        rows = list_all_rows(client, "/api/records", page_size=2)

    assert [row["id"] for row in rows] == ["row-1", "row-2", "row-3"]
    assert offsets == [0, 2]


def test_api_read_rejects_inconsistent_pagination_metadata(tmp_path: Path) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "items": [{"id": "row-1"}],
                "pagination": {
                    "limit": 2,
                    "offset": 0,
                    "count": 0,
                    "total": 1,
                    "has_more": False,
                },
            },
        )

    with SampleClient(
        "http://api.example.test",
        "http://workspace.example.test",
        tmp_path / "requests.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        with pytest.raises(SampleVerificationError, match="pagination"):
            list_all_rows(client, "/api/records", page_size=2)


def test_named_invoice_verification_uses_live_values_and_required_edge() -> None:
    records = {
        "invoice-server-id": {"data": {"invoice-total-field": 12_000}},
        "payment-server-id": {"data": {"payment-amount-field": 4_500}},
    }
    mappings = {
        "invoices:000001": "invoice-server-id",
        "payments:000001": "payment-server-id",
    }
    fields = {
        "invoices:total": "invoice-total-field",
        "payments:amount": "payment-amount-field",
    }

    assert (
        named_invoice_issues(
            records,
            mappings,
            fields,
            "invoice-payments-field",
            {("invoice-payments-field", "invoice-server-id", "payment-server-id")},
        )
        == []
    )
    records["payment-server-id"]["data"]["payment-amount-field"] = 4_600
    assert named_invoice_issues(
        records,
        mappings,
        fields,
        "invoice-payments-field",
        set(),
    ) == [
        "partially paid invoice amounts differ from the named scenario",
        "partially paid invoice relationship is missing",
    ]


def test_audit_verification_requires_entity_actor_and_real_request_context() -> None:
    matching = {
        "entity_id": "record-id",
        "performed_by": "actor-id",
        "action": "create",
        "request_method": "POST",
        "request_path": "/api/records",
        "request_id": "00000000-0000-0000-0000-000000000001",
    }

    assert has_matching_audit(
        [matching],
        entity_id="record-id",
        actor_id="actor-id",
        methods={"POST"},
        path_prefix="/api/records",
    )
    assert has_matching_audit(
        [
            {
                **matching,
                "action": "update",
                "request_method": "PATCH",
                "request_path": "/api/records/record-id",
            }
        ],
        entity_id="record-id",
        actor_id="actor-id",
        methods={"PATCH"},
        path_prefix="/api/records/record-id",
        action="update",
    )
    assert not has_matching_audit(
        [{**matching, "performed_by": "wrong-actor"}],
        entity_id="record-id",
        actor_id="actor-id",
        methods={"POST"},
        path_prefix="/api/records",
    )
    assert not has_matching_audit(
        [{**matching, "request_id": None}],
        entity_id="record-id",
        actor_id="actor-id",
        methods={"POST"},
        path_prefix="/api/records",
    )


def test_record_payload_maps_published_fields_and_resolves_actor_values() -> None:
    from operations.sample_blueprint import SampleRecord

    record = SampleRecord(
        "invoices:000001",
        "invoices",
        "finance",
        {
            "document-name": "Harbor invoice",
            "document-owner": "@user:internal_finance_03",
            "document-total": 12_000,
            "document-zero": 0,
        },
        creator_key="internal_finance_02",
        assignee_key="internal_finance_03",
    )

    payload = build_record_payload(
        record,
        module_id="module-id",
        api_field_ids={
            "document-name": "api-name",
            "document-owner": "api-owner",
            "document-total": "api-total",
            "document-zero": "api-zero",
        },
        actor_ids={"internal_finance_03": "finance-user-id"},
    )

    assert payload == {
        "module_id": "module-id",
        "data": {
            "api-name": "Harbor invoice",
            "api-owner": "finance-user-id",
            "api-total": 12_000,
            "api-zero": 0,
        },
    }


def test_record_payload_refuses_unmapped_fields_or_missing_actors() -> None:
    from operations.sample_blueprint import SampleRecord

    record = SampleRecord(
        "invoices:000001",
        "invoices",
        "finance",
        {
            "document-owner": "@user:internal_finance_03",
        },
        creator_key="internal_finance_02",
        assignee_key="internal_finance_03",
    )
    with pytest.raises(SampleWorkflowError, match="field mapping"):
        build_record_payload(
            record,
            module_id="module-id",
            api_field_ids={},
            actor_ids={"internal_finance_03": "finance-user-id"},
        )
    with pytest.raises(SampleWorkflowError, match="person mapping"):
        build_record_payload(
            record,
            module_id="module-id",
            api_field_ids={"document-owner": "api-owner"},
            actor_ids={},
        )


def test_relationship_write_uses_assignment_for_single_target_and_post_for_many() -> None:
    assert relationship_write(
        field_id="single-field",
        source_id="source-id",
        target_id="target-id",
        field={"relationship_multiple_targets": False},
    ) == (
        "PUT",
        "/api/relationships/fields/single-field/sources/source-id",
        {"target_record_id": "target-id"},
    )
    assert relationship_write(
        field_id="many-field",
        source_id="source-id",
        target_id="target-id",
        field={"relationship_multiple_targets": True},
    ) == (
        "POST",
        "/api/relationships",
        {
            "field_id": "many-field",
            "source_record_id": "source-id",
            "target_record_id": "target-id",
        },
    )


class _BaselineClient:
    def __init__(self, workspace: dict[str, object], sandbox: dict[str, object]) -> None:
        self.workspace = workspace
        self.sandbox = sandbox
        self.methods: list[str] = []

    def request(self, method: str, path: str, **_kwargs: object) -> httpx.Response:
        self.methods.append(method)
        if path == "/api/workspace":
            return httpx.Response(200, json=self.workspace)
        if path == "/api/sandbox/document":
            return httpx.Response(200, json=self.sandbox)
        raise AssertionError(f"unexpected baseline request: {path}")


def test_baseline_refuses_partial_workspace_or_sandbox_without_any_write() -> None:
    fresh_sandbox = _document()

    workspace_client = _BaselineClient(
        _workspace(timezone="Asia/Manila"),
        fresh_sandbox,
    )
    with pytest.raises(SampleVerificationError, match="workspace"):
        assert_pristine_baseline(workspace_client, admin_id="admin-id")
    assert workspace_client.methods == ["GET"]

    sandbox_client = _BaselineClient(
        _workspace(),
        _document(
            document={
                "kind": "openslate-sandbox",
                "schemaVersion": 4,
                "design": {
                    "departments": [{"id": "partial"}],
                    "modules": [],
                    "relationships": [],
                    "layout": {},
                },
                "triggers": [],
                "scenarios": [],
            }
        ),
    )
    with pytest.raises(SampleVerificationError, match="Sandbox"):
        assert_pristine_baseline(sandbox_client, admin_id="admin-id")
    assert sandbox_client.methods == ["GET", "GET"]


def test_plan_summary_reports_exact_profile_counts_and_fixed_supporting_catalogue() -> None:
    from datetime import date

    dataset = build_dataset("small", 42, date(2026, 9, 29))

    summary = build_plan_summary(dataset)

    assert summary["operational_records"] == 1_001
    assert summary["department_count"] == 6
    assert summary["module_count"] == 24
    assert summary["relationship_definition_count"] == 18
    assert summary["relationship_edges"] == 1_145
    assert summary["automation_count"] == 8
    assert summary["test_vector_count"] == 8
    assert summary["module_counts"]["stock_counts"] == 25
    assert summary["module_counts"]["customers"] == 15
    assert summary["supporting_counts"] == {
        "identities": 44,
        "built_in_account_roles_preserved": 3,
        "groups": 9,
        "boards": 12,
        "widgets": 48,
        "posts": 96,
        "events": 144,
        "reminders": 24,
        "attachments": 0,
        "views": 36,
        "dashboards": 6,
        "dashboard_widgets": 24,
        "reports": 12,
    }


def test_mailpit_preflight_rejects_an_unowned_project_network(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    network_name = "openslate_mail-egress"
    expected_workdir = str(Path(seed_operator.__file__).resolve().parents[2] / "infra" / "supabase")
    auth = {
        "Config": {
            "Labels": {
                "com.docker.compose.project": "openslate",
                "com.docker.compose.service": "auth",
                "com.docker.compose.project.working_dir": expected_workdir,
            },
            "Env": ["GOTRUE_SMTP_HOST=mailpit", "GOTRUE_SMTP_PORT=1025"],
        },
        "State": {"Running": True},
        "NetworkSettings": {"Networks": {network_name: {"NetworkID": "mail-network-id"}}},
    }
    mailpit = {
        "Config": {
            "Image": PROVIDER_IMAGES["mailpit"],
            "Labels": {
                "com.docker.compose.project": "openslate",
                "com.docker.compose.service": "mailpit",
                "com.docker.compose.project.working_dir": expected_workdir,
            },
            "Env": ["MP_SMTP_BIND_ADDR=0.0.0.0:1025"],
        },
        "State": {"Running": True},
        "NetworkSettings": {
            "Networks": {network_name: {"NetworkID": "mail-network-id"}},
            "Ports": {"8025/tcp": [{"HostIp": "127.0.0.1", "HostPort": "58025"}]},
        },
    }
    network = {
        "Name": network_name,
        "Labels": {"com.docker.compose.project": "another-project"},
        "Id": "mail-network-id",
    }

    def inspect(arguments: list[str]) -> list[dict[str, object]]:
        return [network] if arguments[0] == "network" else [auth, mailpit]

    monkeypatch.setattr(seed_operator, "_docker_json", inspect)
    target = InstanceTarget("openslate", "127.0.0.1", 55432, "postgres", None, "openslate")

    with pytest.raises(SampleOperationError, match="Mailpit ownership"):
        _assert_owned_mailpit({"SUPABASE_MAIL_PORT": "58025"}, target)
