"""Final configuration follows planned changes, rather than creation-time state."""

import copy
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.service import canonical_document
from operations.sample.client import SampleClient
from operations.sample.phases.plan import phase_version_documents, plan_phases
from operations.sample.verification.configuration import verify_configuration
from operations.sample.verification.core import SampleVerificationError
from operations.sample.verification.run import _people_issues, read_run_manifest
from tests.operations.sample.sample_datasets import mutation_aware_cache, private_copy
from tests.operations.sample.verification.test_sample_run_verification import (
    _configuration_base,
    _configuration_fixture,
    _id,
    _manifest,
)


@pytest.mark.parametrize("actual_role", ("admin", "member"))
def test_people_readback_uses_the_recorded_promotion_not_result_claims(tmp_path, actual_role):
    payloads, manifest, context = _configuration_fixture()
    person_key = "internal_sales_02"
    person_id = manifest["people"][person_key]["user_id"]
    manifest["phase_plan"] = [
        {
            "key": "admin:promotion",
            "phase": "admin",
            "kind": "promote_user",
            "actor_key": "admin",
            "target_key": person_key,
            "values": {"role": "admin", "removed_group_keys": ["sales-desk"]},
            "expected_status": 200,
            "expected_detail": None,
            "expected_end_state": {"role": "admin"},
        }
    ]
    # A result cannot redefine the expected role: the recorded plan is authoritative.
    manifest["phase_results"] = [{"expected_end_state": {"role": actual_role}}]
    users = copy.deepcopy(payloads["/api/users"])
    next(row for row in users if row["id"] == person_id)["role"] = actual_role

    def handler(request):
        assert request.method == "GET" and request.url.path == "/api/users"
        offset, limit = int(request.url.params["offset"]), int(request.url.params["limit"])
        items = users[offset : offset + limit]
        return httpx.Response(
            200,
            json={
                "items": items,
                "pagination": {
                    "offset": offset,
                    "limit": limit,
                    "count": len(items),
                    "total": len(users),
                    "has_more": offset + len(items) < len(users),
                },
            },
        )

    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "journal.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        _, issues = _people_issues(
            client, manifest, "admin-a", organization=context["dataset"].organization
        )
    if actual_role == "admin":
        assert issues == []
    else:
        assert any("identity, role or account state differs" in issue for issue in issues)


@pytest.mark.parametrize("invalid_plan", ({}, [{"kind": "unplanned"}]))
def test_invalid_phase_plan_is_refused_before_authentication(tmp_path, invalid_plan):
    directory = tmp_path / ("a" * 32)
    _manifest(directory, phase_plan=invalid_plan)
    with pytest.raises(SampleVerificationError, match="phase plan"):
        read_run_manifest(directory, "admin-a")


def test_creation_time_configuration_cannot_satisfy_the_planned_reorganization(tmp_path):
    payloads, manifest, context = _configuration_fixture()

    def handler(request):
        assert request.method == "GET"
        payload = payloads[request.url.path]
        if isinstance(payload, list):
            offset = int(request.url.params["offset"])
            limit = int(request.url.params["limit"])
            items = payload[offset : offset + limit]
            return httpx.Response(
                200,
                json={
                    "items": items,
                    "pagination": {
                        "offset": offset,
                        "limit": limit,
                        "count": len(items),
                        "total": len(payload),
                        "has_more": offset + len(items) < len(payload),
                    },
                },
            )
        return httpx.Response(200, json=payload)

    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "journal.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        _, issues = verify_configuration(
            client,
            dataset=context["dataset"],
            mappings=manifest["mappings"],
            people=manifest["people"],
            phase_actions=plan_phases(context["dataset"]),
        )
    assert any("Sandbox" in issue or "published" in issue for issue in issues)


def _phase_configuration_fixture():
    """Return a private copy of the reorganized readback, with guest expiry set from now."""

    payloads, manifest, dataset, actions = private_copy(_phase_configuration_base())
    for row in payloads["/api/users"]:
        if row["role"] == "guest":
            row["expires_at"] = (datetime.now(UTC) + timedelta(days=90)).isoformat()
    return payloads, manifest, dataset, actions


@mutation_aware_cache
def _phase_configuration_base():
    """Build the reorganized readback once per process from the foundation readback."""

    payloads, manifest, context = private_copy(_configuration_base())
    dataset = context["dataset"]
    actions = tuple(action for action in plan_phases(dataset) if action.kind.startswith("sandbox_"))
    documents = phase_version_documents(dataset, actions)
    versions = manifest["mappings"]["sandbox_versions"]
    versions.update({key: _id("version:" + key) for key in documents if key not in versions})
    payloads["/api/sandbox/versions"] = []
    for key, document in documents.items():
        parsed = SandboxDocument.model_validate(document)
        canonical, digest, _ = canonical_document(parsed)
        row = {
            "id": versions[key],
            "kind": "checkpoint" if key.endswith("checkpoint") else "published",
            "contentHash": digest,
            "isDeleted": False,
        }
        payloads["/api/sandbox/versions"].append(row)
        payloads[f"/api/sandbox/versions/{versions[key]}"] = {**row, "document": canonical}
    final_document = payloads[f"/api/sandbox/versions/{versions['phase_design_restored']}"]
    current = payloads["/api/sandbox/document"]
    current.update(
        document=copy.deepcopy(final_document["document"]),
        contentHash=final_document["contentHash"],
        publishedHash=final_document["contentHash"],
        latestPublishedVersion={"id": versions["phase_design_restored"]},
    )
    values = next(action.values for action in actions if action.kind == "sandbox_edit_publish")
    mappings = manifest["mappings"]
    mappings["modules"][values["new_module_key"]] = values["new_module_id"]
    mappings["fields"][f"{values['new_module_key']}:{values['title_field_key']}"] = values[
        "title_field_id"
    ]
    mappings["fields"][f"{values['module_key']}:{values['added_field_key']}"] = values[
        "added_field_id"
    ]
    types = {"Text": "text", "Long text": "long_text", "Select": "select"}
    by_id = {row["id"]: row for row in payloads["/api/fields"]}
    modules = payloads["/api/modules"]
    for module in documents["phase_design_restored"]["design"]["modules"]:
        live = next((row for row in modules if row["id"] == module["id"]), None)
        if live is None:
            live = {
                "id": module["id"],
                "department_id": module["departmentId"],
                "title_field_id": module["titleFieldId"],
                "is_deleted": False,
            }
            modules.append(live)
        live["module_name"] = module["name"]
        for position, field in enumerate(module["fields"]):
            config = {
                "minimum" if k == "min" else "maximum" if k == "max" else k: v
                for k, v in field["config"].items()
                if k != "kind"
            }
            if field["id"] in by_id:
                by_id[field["id"]]["config"] = config
                continue
            payloads["/api/fields"].append(
                {
                    "id": field["id"],
                    "module_id": module["id"],
                    "name": field["name"],
                    "type": types[field["type"]],
                    "required": field["required"],
                    "config": config,
                    "position": position,
                    "is_deleted": False,
                }
            )
        relation_rows = [
            row
            for row in payloads["/api/fields"]
            if row["module_id"] == module["id"] and row["type"] == "relationship"
        ]
        for index, row in enumerate(relation_rows):
            row["position"] = len(module["fields"]) + index
    return payloads, manifest, dataset, actions


@pytest.mark.parametrize(
    "changed", ("none", "closed", "missing_field", "missing_version", "old_title", "current_hash")
)
def test_final_design_readback_requires_reopened_module_and_preserved_history(tmp_path, changed):
    payloads, manifest, dataset, actions = _phase_configuration_fixture()
    new_id = manifest["mappings"]["modules"]["phase_checklist"]
    if changed == "closed":
        next(row for row in payloads["/api/modules"] if row["id"] == new_id)["is_deleted"] = True
    elif changed == "missing_field":
        field_id = manifest["mappings"]["fields"]["invoices:operational_review_notes"]
        payloads["/api/fields"] = [row for row in payloads["/api/fields"] if row["id"] != field_id]
    elif changed == "missing_version":
        payloads["/api/sandbox/versions"].pop(0)
    elif changed == "old_title":
        payloads["/api/modules"][0]["title_field_id"] = _id("unexpected-title")
    elif changed == "current_hash":
        payloads["/api/sandbox/document"]["contentHash"] = "a" * 64
        payloads["/api/sandbox/document"]["publishedHash"] = "a" * 64

    def handler(request):
        assert request.method == "GET"
        payload = payloads[request.url.path]
        if isinstance(payload, list):
            offset, limit = int(request.url.params["offset"]), int(request.url.params["limit"])
            items = payload[offset : offset + limit]
            return httpx.Response(
                200,
                json={
                    "items": items,
                    "pagination": {
                        "offset": offset,
                        "limit": limit,
                        "count": len(items),
                        "total": len(payload),
                        "has_more": offset + len(items) < len(payload),
                    },
                },
            )
        return httpx.Response(200, json=payload)

    with SampleClient(
        "https://api.example.test",
        "https://workspace.example.test",
        tmp_path / "journal.jsonl",
        transport=httpx.MockTransport(handler),
    ) as client:
        observed, issues = verify_configuration(
            client,
            dataset=dataset,
            mappings=manifest["mappings"],
            people=manifest["people"],
            phase_actions=actions,
        )
    assert bool(issues) is (changed != "none"), issues
    if changed == "none":
        assert observed["sandbox_versions_verified"] == 9
        assert observed["modules_verified"] == 25


def test_retained_lifecycle_snapshot_contains_disposable_structure_not_final_phase_ids():
    _, _, dataset, actions = _phase_configuration_fixture()
    documents = phase_version_documents(dataset, actions)
    assert "control_lifecycle_published" in documents
    initial_ids = {module["id"] for module in dataset.document["design"]["modules"]}
    temporary = [
        module
        for module in documents["control_lifecycle_published"]["design"]["modules"]
        if module["id"] not in initial_ids
    ]
    assert len(temporary) == 1
    spec = dataset.organization.phases.design
    assert temporary[0]["name"] == spec.new_module_name
    assert {field["name"] for field in temporary[0]["fields"]} == {
        spec.new_module_title_field_name,
        spec.text_field_name,
    }
    final_ids = {module["id"] for module in documents["phase_design_restored"]["design"]["modules"]}
    assert temporary[0]["id"] not in final_ids
    initial_departments = {dept["id"] for dept in dataset.document["design"]["departments"]}
    departments = [
        dept
        for dept in documents["control_lifecycle_published"]["design"]["departments"]
        if dept["id"] not in initial_departments
    ]
    assert len(departments) == 1
    assert departments[0]["name"] == (
        f"{dataset.organization.identity.workspace_name} structure review"
    )
    assert temporary[0]["departmentId"] == departments[0]["id"]
