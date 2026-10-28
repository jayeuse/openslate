"""A verification command must not authenticate an unsafe or unfinished run."""

from __future__ import annotations

import json
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_DNS, uuid5

import httpx
import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from operations.sample.population.people import _GROUP_ACCESS, _people
from operations.sample.verification.core import SampleVerificationError
from operations.sample.verification.run import read_run_manifest, verify_sample_data
from tests.operations.sample.sample_datasets import (
    mutation_aware_cache,
    private_copy,
    sample_dataset,
)

# The installation operator verifies the run; the pack administrator ran it.
OPERATOR_EMAIL = "admin@example.test"
PACK_ADMIN_ID = str(uuid5(NAMESPACE_DNS, "sample-verification:pack-administrator"))
PACK_ADMIN_EMAIL = "administrator@harbor-ops.example"
PACK_ADMIN_ROW = {
    "id": PACK_ADMIN_ID,
    "email": PACK_ADMIN_EMAIL,
    "username": "harbor-administrator",
    "role": "admin",
    "status": "active",
    "is_deleted": False,
}
LOGIN_IDS = {OPERATOR_EMAIL: "admin-a", PACK_ADMIN_EMAIL: PACK_ADMIN_ID}


def write_roster(directory: Path) -> None:
    """The run's private roster holds the pack administrator's generated password."""
    path = directory / "credentials.json"
    account = {"key": "administrator", "email": PACK_ADMIN_EMAIL, "password": "synthetic-admin"}
    path.write_text(json.dumps({"accounts": [account]}))
    path.chmod(0o600)


def _manifest(directory: Path, **changes: object) -> None:
    directory.mkdir(mode=0o700)
    write_roster(directory)
    payload = {
        "schema_version": 1,
        "run_id": directory.name,
        "admin_id": PACK_ADMIN_ID,
        "operator_id": "admin-a",
        "status": "complete",
        "profile": "small",
        "seed": 42,
        "anchor_date": "2026-09-29",
        "started_at": "2026-09-29T00:00:00+00:00",
        "finished_at": "2026-09-29T01:00:00+00:00",
        "mappings": {},
        "actor_ids": {},
        "content_counts": {},
        "people": {},
        **changes,
    }
    path = directory / "manifest.json"
    path.write_text(json.dumps(payload))
    path.chmod(0o600)


def test_manifest_refuses_another_operator_before_network(tmp_path: Path) -> None:
    directory = tmp_path / ("a" * 32)
    _manifest(directory)
    with pytest.raises(SampleVerificationError, match="another operator"):
        read_run_manifest(directory, "admin-b")


@pytest.mark.parametrize("admin_id", [None, "admin-a", "not-a-uuid", PACK_ADMIN_ID.upper()])
def test_manifest_refuses_a_missing_or_operator_pack_administrator(
    tmp_path: Path, admin_id: object
) -> None:
    directory = tmp_path / ("a" * 32)
    _manifest(directory, admin_id=admin_id)
    with pytest.raises(SampleVerificationError, match="pack administrator"):
        read_run_manifest(directory, "admin-a")


def test_manifest_refuses_public_or_symlinked_evidence(tmp_path: Path) -> None:
    directory = tmp_path / ("a" * 32)
    _manifest(directory)
    path = directory / "manifest.json"
    path.chmod(0o644)
    with pytest.raises(SampleVerificationError, match="private"):
        read_run_manifest(directory, "admin-a")
    path.chmod(0o600)
    alias = tmp_path / "alias"
    alias.symlink_to(directory, target_is_directory=True)
    with pytest.raises(SampleVerificationError, match="private"):
        read_run_manifest(alias, "admin-a")


def test_a_run_stopped_before_its_invitation_reads_as_incomplete(tmp_path: Path) -> None:
    directory = tmp_path / ("a" * 32)
    _manifest(directory, status="incomplete", admin_id=None)
    assert read_run_manifest(directory, "admin-a")["admin_id"] is None


def test_manifest_preserves_incomplete_state_for_reporting(tmp_path: Path) -> None:
    directory = tmp_path / ("a" * 32)
    _manifest(directory, status="incomplete", finished_at=None)
    result = read_run_manifest(directory, "admin-a")
    assert result["status"] == "incomplete"
    assert result["finished_at"] is None


def test_manifest_can_be_read_while_population_awaits_verification(tmp_path: Path) -> None:
    directory = tmp_path / ("a" * 32)
    _manifest(directory, status="populated")
    assert read_run_manifest(directory, "admin-a")["status"] == "populated"


def test_trigger_evidence_requires_the_recorded_successful_run() -> None:
    from operations.sample.verification.run import trigger_evidence_issues

    evidence = [
        {
            "trigger_key": "quote-value-changed",
            "name": "Flag quotes",
            "enabled": True,
            "run_ids": ["run-a"],
            "target_logical_id": "quotes:000001",
            "target_field_id": "flag",
            "expected_value": True,
        }
    ]
    records = {"quotes:000001": {"flag": True}}
    assert trigger_evidence_issues(evidence, [], records)
    wrong = [
        {
            "id": "run-a",
            "triggerName": "Other rule",
            "state": "succeeded",
            "details": {"actionsApplied": 1},
        }
    ]
    assert trigger_evidence_issues(evidence, wrong, records)
    correct = [
        {
            "id": "run-a",
            "triggerName": "Flag quotes",
            "state": "succeeded",
            "details": {"actionsApplied": 1},
        }
    ]
    assert not trigger_evidence_issues(evidence, correct, records)
    assert trigger_evidence_issues(evidence, correct, {"quotes:000001": {"flag": False}})


def _id(label: str) -> str:
    return str(uuid5(NAMESPACE_DNS, "sample-verification:" + label))


def _configuration_fixture() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Return a private copy of the foundation readback, with guest expiry set from now."""

    payloads, manifest, context = private_copy(_configuration_base())
    for row in payloads["/api/users"]:
        if row["role"] == "guest":
            row["expires_at"] = (datetime.now(UTC) + timedelta(days=90)).isoformat()
    return payloads, manifest, context


@mutation_aware_cache
def _configuration_base() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """Build the readback once per process; ``_configuration_fixture`` copies it."""

    dataset = sample_dataset("small", 42, date(2026, 9, 29))
    authored_document: dict[str, Any] = dataset.document
    document = SandboxDocument.model_validate(authored_document).model_dump(
        mode="json", by_alias=True
    )
    design = authored_document["design"]
    department_ids = {key: value for key, value in dataset.department_ids.items()}
    module_ids = {key: value for key, value in dataset.module_ids.items()}
    field_ids = {
        f"{module_key}:{field_key}": field_id
        for module_key, fields in dataset.field_ids.items()
        for field_key, field_id in fields.items()
    }
    mappings = {
        "departments": department_ids,
        "modules": module_ids,
        "fields": field_ids,
        "relationships": dict(dataset.relationship_ids),
        "sandbox_versions": {
            "initial_checkpoint": _id("checkpoint"),
            "published": _id("published"),
        },
        "sandbox_tests": {
            vector.key.replace("-", "_"): _id("test:" + vector.key)
            for vector in dataset.test_vectors
        },
        "group": {key: _id("group:" + key) for key in _GROUP_ACCESS},
        "user": {person.key: _id("user:" + person.key) for person in _people()},
    }
    people = {
        person.key: {
            "user_id": mappings["user"][person.key],
            "role": person.role,
            "status": person.status,
        }
        for person in _people()
    }
    sponsor = mappings["user"]["internal_sales_lead"]
    users = [{"id": "admin-a", "role": "admin", "status": "active"}, dict(PACK_ADMIN_ROW)]
    for person in _people():
        users.append(
            {
                "id": mappings["user"][person.key],
                "role": person.role,
                "status": person.status,
                "email": person.email,
                "username": person.username,
                "display_name": person.name,
                "job_title": person.title,
                "sponsor_user_id": sponsor if person.role == "guest" else None,
                # _configuration_fixture sets each guest's expiry when a test takes a copy.
                "expires_at": None,
                "is_deleted": False,
            }
        )
    groups = []
    for slug, entries in _GROUP_ACCESS.items():
        groups.append(
            {
                "id": mappings["group"][slug],
                "name": " ".join(part.capitalize() for part in slug.split("-")),
                "member_ids": [
                    mappings["user"][person.key] for person in _people() if slug in person.groups
                ],
                "access": [
                    {
                        "department_id": department_ids[department],
                        "module_id": module_ids[module] if module else None,
                        "level": level,
                    }
                    for department, module, level in entries
                ],
                "is_deleted": False,
            }
        )
    departments = [
        {"id": item["id"], "department_name": item["name"], "is_deleted": False}
        for item in design["departments"]
    ]
    modules = [
        {
            "id": item["id"],
            "module_name": item["name"],
            "department_id": item["departmentId"],
            "title_field_id": item["titleFieldId"],
            "is_deleted": False,
        }
        for item in design["modules"]
    ]
    fields = []
    types = {
        "Text": "text",
        "Long text": "long_text",
        "Number": "number",
        "Integer": "int",
        "Date": "date",
        "Date/Time": "datetime",
        "Checkbox": "boolean",
        "Select": "select",
        "Email": "email",
        "URL": "url",
        "User": "user",
    }
    for module in design["modules"]:
        for index, field in enumerate(module["fields"]):
            config = {key: value for key, value in field["config"].items() if key != "kind"}
            config = {
                ("minimum" if key == "min" else "maximum" if key == "max" else key): value
                for key, value in config.items()
            }
            fields.append(
                {
                    "id": field["id"],
                    "module_id": module["id"],
                    "name": field["name"],
                    "type": types[field["type"]],
                    "required": field["required"],
                    "config": config,
                    "position": index,
                    "is_deleted": False,
                }
            )
    module_field_counts = {module["id"]: len(module["fields"]) for module in design["modules"]}
    cardinality = {
        "one-to-one": (False, False),
        "one-to-many": (True, False),
        "many-to-many": (True, True),
    }
    for relation in design["relationships"]:
        source = relation["sourceModuleId"]
        multiple_targets, multiple_sources = cardinality[relation["cardinality"]]
        fields.append(
            {
                "id": relation["id"],
                "module_id": source,
                "name": relation["name"],
                "type": "relationship",
                "required": False,
                "config": {},
                "position": module_field_counts[source],
                "is_deleted": False,
                "relationship_target_module_id": relation["targetModuleId"],
                "relationship_multiple_targets": multiple_targets,
                "relationship_multiple_sources": multiple_sources,
            }
        )
        module_field_counts[source] += 1
    versions = [
        {
            "id": mappings["sandbox_versions"]["initial_checkpoint"],
            "kind": "checkpoint",
            "label": "Harbor Operations Initial Design",
            "contentHash": "sample-hash",
            "isDeleted": False,
        },
        {
            "id": mappings["sandbox_versions"]["published"],
            "kind": "published",
            "label": "Harbor Operations Sample",
            "contentHash": "sample-hash",
            "isDeleted": False,
        },
    ]
    tests = [
        {
            "id": mappings["sandbox_tests"][vector.key.replace("-", "_")],
            "input": {"moduleId": dataset.module_ids[vector.module_key], "values": vector.values},
            "event": vector.event,
            "triggerIds": list(vector.trigger_ids),
            "result": {"issues": []},
        }
        for vector in dataset.test_vectors
    ]
    next(row for row in tests if row["event"].get("frequency") == "daily")["event"] = {
        "kind": "schedule",
        "frequency": "daily",
        "time": "09:00",
        "weekday": None,
    }
    payloads = {
        "/api/users": users,
        "/api/access/groups": groups,
        "/api/departments": departments,
        "/api/modules": modules,
        "/api/fields": fields,
        "/api/sandbox/versions": versions,
        "/api/sandbox/tests": tests,
        "/api/workspace": {
            "display_name": "Harbor Operations Group",
            "locale": "en-US",
            "timezone": "Asia/Manila",
            "currency": "PHP",
            "mark": "HOG",
            "week_start": "monday",
            "business_hours": "09:00–18:00",
            "revision": 2,
        },
        "/api/sandbox/document": {
            "document": document,
            "revision": 3,
            "contentHash": "sample-hash",
            "publishedHash": "sample-hash",
            "hasUnpublishedChanges": False,
            "issues": [],
            "latestPublishedVersion": {
                "id": mappings["sandbox_versions"]["published"],
                "sequence": 2,
            },
        },
    }
    for group in groups:
        payloads[f"/api/access/groups/{group['id']}"] = group
    for version in versions:
        payloads[f"/api/sandbox/versions/{version['id']}"] = {**version, "document": document}
    manifest = {
        "schema_version": 1,
        "admin_id": PACK_ADMIN_ID,
        "operator_id": "admin-a",
        "status": "complete",
        "profile": "small",
        "seed": 42,
        "anchor_date": "2026-09-29",
        "mappings": mappings,
        "people": people,
        "actor_ids": {},
        "content_counts": {},
        "started_at": "2026-09-29T00:00:00Z",
        "finished_at": "2026-09-29T01:00:00Z",
    }
    return payloads, manifest, {"dataset": dataset}


@pytest.mark.parametrize(
    "changed",
    (
        "none",
        "guest_sponsor",
        "guest_expiry",
        "group_member",
        "group_access",
        "workspace",
        "organization_fields",
        "sandbox_document",
        "field_config",
        "relationship_target",
        "publication",
        "test_history",
        "control_plan",
        "route_coverage",
        "pack_administrator",
        "operator_missing",
    ),
)
def test_verifier_requires_exact_foundation_readback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, changed: str
) -> None:
    from operations.sample.verification import run as verifier

    payloads, manifest, _ = _configuration_fixture()
    if changed == "guest_sponsor":
        next(row for row in payloads["/api/users"] if row["role"] == "guest")["sponsor_user_id"] = (
            _id("wrong-sponsor")
        )
    elif changed == "guest_expiry":
        next(row for row in payloads["/api/users"] if row["role"] == "guest")["expires_at"] = (
            datetime.now(UTC) - timedelta(days=1)
        ).isoformat()
    elif changed == "group_member":
        group = payloads["/api/access/groups"][0]
        group["member_ids"].pop()
    elif changed == "group_access":
        group = payloads["/api/access/groups"][0]
        group["access"][0]["level"] = "read"
    elif changed == "workspace":
        payloads["/api/workspace"]["timezone"] = "UTC"
    elif changed == "organization_fields":
        payloads["/api/workspace"]["currency"] = "USD"
    elif changed == "sandbox_document":
        payloads["/api/sandbox/document"]["document"] = {
            **payloads["/api/sandbox/document"]["document"],
            "triggers": [],
        }
    elif changed == "field_config":
        next(row for row in payloads["/api/fields"] if row["type"] == "number")["config"] = {
            "minimum": 9_999
        }
    elif changed == "relationship_target":
        next(row for row in payloads["/api/fields"] if row["type"] == "relationship")[
            "relationship_target_module_id"
        ] = _id("wrong-module")
    elif changed == "publication":
        payloads["/api/sandbox/document"]["latestPublishedVersion"] = None
    elif changed == "test_history":
        payloads["/api/sandbox/tests"].pop()
    elif changed == "control_plan":
        manifest["control_plan"] = []
        manifest["control_results"] = []
    elif changed == "route_coverage":
        manifest["control_plan"] = []
    elif changed == "pack_administrator":
        next(row for row in payloads["/api/users"] if row["id"] == PACK_ADMIN_ID)["role"] = "member"
    elif changed == "operator_missing":
        payloads["/api/users"] = [row for row in payloads["/api/users"] if row["id"] != "admin-a"]

    class FakeClient:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            self.email = ""

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *_args: object) -> None:
            pass

        def login(self, email: str, _password: str) -> httpx.Response:
            self.email = email
            return httpx.Response(200, json={})

        def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
            if method == "POST" and path == "/api/auth/logout":
                return httpx.Response(200, json={})
            if path == "/api/auth/me":
                return httpx.Response(200, json={"id": LOGIN_IDS[self.email]})
            if path not in payloads:
                raise AssertionError(f"Unexpected API read: {path}")
            value = payloads[path]
            if isinstance(value, list):
                params = kwargs.get("params", {})
                offset, limit = params.get("offset", 0), params.get("limit", 100)
                rows = value[offset : offset + limit]
                if path.startswith("/api/sandbox/"):
                    return httpx.Response(
                        200,
                        json={
                            "items": rows,
                            "limit": limit,
                            "offset": offset,
                            "count": len(rows),
                            "total": len(value),
                            "hasMore": offset + len(rows) < len(value),
                        },
                    )
                return httpx.Response(
                    200,
                    json={
                        "items": rows,
                        "pagination": {
                            "limit": limit,
                            "offset": offset,
                            "count": len(rows),
                            "total": len(value),
                            "has_more": offset + len(rows) < len(value),
                        },
                    },
                )
            return httpx.Response(200, json=value)

    monkeypatch.setattr(verifier, "read_run_manifest", lambda *_args: manifest)
    monkeypatch.setattr(verifier, "SampleClient", FakeClient)
    monkeypatch.setattr(
        verifier, "verify_records_and_relationships", lambda *_args, **_kwargs: ({}, [])
    )
    monkeypatch.setattr(
        verifier, "verify_content", lambda *_args, **_kwargs: ({"content_complete": 1})
    )
    monkeypatch.setattr(verifier, "_verify_triggers", lambda *_args, **_kwargs: ({}, []))
    monkeypatch.setattr(verifier, "verify_history", lambda *_args, **_kwargs: ({}, []))
    monkeypatch.setattr(verifier, "verify_rejections", lambda *_args, **_kwargs: ({}, []))
    if changed == "route_coverage":
        monkeypatch.setattr(
            verifier, "verify_controls", lambda *_args, **_kwargs: ({}, []), raising=False
        )
        monkeypatch.setattr(verifier, "configuration_mappings", lambda *_args: manifest["mappings"])
    write_roster(tmp_path)
    result = verify_sample_data(
        api_url="https://api.example.test",
        origin="https://ui.example.test",
        operator_email=OPERATOR_EMAIL,
        expected_operator_id="admin-a",
        operator_password="synthetic",
        run_directory=tmp_path,
    )
    assert result.status == ("complete" if changed == "none" else "incomplete")
    if changed == "pack_administrator":
        assert "the pack administrator's identity, role or account state differs" in result.issues
    if changed == "operator_missing":
        assert "identity roster differs from the recorded run" in result.issues
