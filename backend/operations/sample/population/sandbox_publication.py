"""Publish the generated Sandbox design as the pack administrator, with its reviews."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from operations.sample.blueprint import SampleDataset
from operations.sample.client import SampleClient
from operations.sample.population.run import SamplePopulationError, _api, _api_id


def _publish_sandbox(
    admin: SampleClient, dataset: SampleDataset, admin_password: str, run_id: str, admin_id: str
) -> dict[str, Any] | None:
    saved = _api(
        admin,
        "PUT",
        "/api/sandbox/document",
        body={"expectedRevision": 1, "document": dataset.document},
    )
    revision = _positive_int(saved.get("revision"), "Sandbox revision")
    from operations.sample.controls.version_prune import prepare_prune_fixture

    revision, fixture = prepare_prune_fixture(
        admin, dataset, actor_id=admin_id, run_id=run_id, document_response=saved
    )
    checkpoint = _api(
        admin,
        "POST",
        "/api/sandbox/versions",
        body={
            "expectedRevision": revision,
            "kind": "checkpoint",
            "label": "Initial organization design",
            "note": "Departments, modules and automation rules for review.",
        },
        expected=(201,),
    )
    admin.record_mapping("sandbox_versions", "initial_checkpoint", _api_id(checkpoint))
    current = _api(admin, "GET", "/api/sandbox/document")
    revision = _positive_int(current.get("revision"), "Sandbox revision")
    for vector in dataset.test_vectors:
        result = _api(
            admin,
            "POST",
            "/api/sandbox/tests",
            body={
                "expectedRevision": revision,
                "moduleId": dataset.module_ids[vector.module_key],
                "values": vector.values,
                "event": vector.event,
                "triggerIds": list(vector.trigger_ids),
            },
            expected=(201,),
        )
        admin.record_mapping("sandbox_tests", vector.key.replace("-", "_"), _api_id(result))
    preview = _api(
        admin,
        "POST",
        "/api/sandbox/publication-previews",
        body={"expectedRevision": revision},
    )
    counts = preview.get("counts")
    expected_counts = {
        "departments": len(dataset.department_ids),
        "modules": len(dataset.module_ids),
        "relationships": len(dataset.relationship_ids),
        "triggers": len(dataset.trigger_ids),
    }
    if (
        preview.get("blockers") != []
        or not isinstance(counts, Mapping)
        or any(counts.get(key) != value for key, value in expected_counts.items())
        or not isinstance(preview.get("previewToken"), str)
        or not isinstance(preview.get("impactDigest"), str)
    ):
        raise SamplePopulationError(
            "Sandbox publication preview did not match the generated design"
        )
    publication = _api(
        admin,
        "POST",
        "/api/sandbox/publications",
        body={
            "expectedRevision": revision,
            "previewToken": preview["previewToken"],
            "impactDigest": preview["impactDigest"],
            "password": admin_password,
            "note": "Publish the initial organization structure.",
        },
        headers={"Idempotency-Key": f"sample-{run_id}"},
        expected=(201,),
    )
    version = publication.get("version")
    if not isinstance(version, Mapping):
        raise SamplePopulationError("Sandbox publication did not return a published version")
    admin.record_mapping("sandbox_versions", "published", _api_id(version))
    return fixture


def _positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise SamplePopulationError(f"{label} is missing or invalid")
    return value
