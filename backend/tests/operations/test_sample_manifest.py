"""Private manifests freeze run volumes without authenticating invalid evidence."""

from __future__ import annotations

import json
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any

import httpx
import pytest

from operations.sample.catalog import module_counts
from operations.sample.packs.harbor import PACK
from operations.sample.population.run import populate_sample_data
from operations.sample.verification.core import SampleVerificationError
from operations.sample.verification.run import SampleVerificationReport, verify_sample_data
from tests.operations.test_sample_run_verification import _manifest


def _recorded_counts() -> dict[str, int]:
    counts = module_counts("small", PACK)
    counts["warehouses"] = 4
    return counts


def _v2(**changes: Any) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "organization": "harbor",
        "span": "365-day history; 90-day outlook",
        "sampling_scope": "scaled operational records with supporting content",
        "module_counts": _recorded_counts(),
        **changes,
    }


def _verify(directory: Path) -> SampleVerificationReport:
    return verify_sample_data(
        api_url="https://api.example.test",
        origin="https://ui.example.test",
        admin_email="admin@example.test",
        expected_admin_id="admin-a",
        admin_password="fixture-value",
        run_directory=directory,
    )


def test_population_writes_v2_metadata_and_keeps_all_existing_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from operations.sample.population import workflow
    from operations.sample.verification import run as verifier

    # Exercise the private manifest lifecycle; all population and API work is replaced.
    monkeypatch.setattr(workflow, "run_population", lambda **_kwargs: {})
    monkeypatch.setattr(workflow, "_journal_mappings", lambda _path: {})
    monkeypatch.setattr(
        verifier,
        "verify_sample_data",
        lambda **kwargs: SampleVerificationReport("complete", kwargs["run_directory"], {}, ()),
    )
    report = populate_sample_data(
        api_url="https://api.example.test",
        origin="https://ui.example.test",
        mailpit_url="https://mail.example.test",
        admin_email="admin@example.test",
        expected_admin_id="admin-a",
        admin_password="fixture-value",
        run_root=tmp_path / "runs",
        profile="small",
        seed=42,
        anchor_date=date(2026, 9, 30),
        organization=PACK,
    )
    manifest = json.loads((report.run_directory / "manifest.json").read_text())
    assert report.status == "complete"
    assert manifest["schema_version"] == 2
    assert manifest["organization"] == "harbor"
    assert manifest["span"] == "365-day history; 90-day outlook"
    assert manifest["sampling_scope"] == "scaled operational records with supporting content"
    assert manifest["module_counts"] == module_counts("small", PACK)
    assert manifest["planned_counts"]["records"] == 1_001
    assert manifest["planned_counts"]["identities"] == 44
    assert manifest["planned_counts"]["posts"] == 96
    assert {
        "schema_version",
        "run_id",
        "status",
        "profile",
        "seed",
        "anchor_date",
        "admin_id",
        "started_at",
        "finished_at",
        "mappings",
        "actor_ids",
        "content_counts",
        "people",
        "trigger_evidence",
        "mutation_evidence",
        "observed",
        "stage",
        "failure",
    } <= manifest.keys()


@pytest.mark.parametrize("version,expected_total", [(1, 20_000), (2, 1_004)])
def test_verification_rebuilds_the_recorded_run_for_both_manifest_versions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, version: int, expected_total: int
) -> None:
    from operations.sample.verification import run as verifier

    directory = tmp_path / ("a" * 32)
    _manifest(directory, profile="standard", **(_v2() if version == 2 else {}))

    class OfflineClient:
        def __init__(self, *_args: object) -> None:
            pass

        def __enter__(self) -> OfflineClient:
            return self

        def __exit__(self, *_args: object) -> None:
            pass

        def login(self, *_args: object) -> httpx.Response:
            return httpx.Response(200)

        def request(self, method: str, path: str, **_kwargs: Any) -> httpx.Response:
            assert (method, path) in {("GET", "/api/auth/me"), ("POST", "/api/auth/logout")}
            return httpx.Response(200, json={"id": "admin-a"})

    def read_records(_client: object, *, dataset: Any, **_kwargs: Any):
        assert len(dataset.records) == expected_total
        assert dataset.organization.identity.key == "harbor"
        counts = Counter(record.module_key for record in dataset.records)
        if version == 2:
            assert counts == _recorded_counts()
            assert counts["warehouses"] == 4
        else:
            assert counts["warehouses"] == 10
            assert counts["sales_orders"] == 2_000
        return {"records": len(dataset.records), "relationships": len(dataset.edges)}, []

    monkeypatch.setattr(verifier, "SampleClient", OfflineClient)
    monkeypatch.setattr(verifier, "verify_records_and_relationships", read_records)
    for name in (
        "verify_history",
        "verify_rejections",
        "_people_issues",
        "verify_configuration",
        "_verify_triggers",
    ):
        monkeypatch.setattr(verifier, name, lambda *_args, **_kwargs: ({}, []))
    monkeypatch.setattr(
        verifier, "verify_content", lambda *_args, **_kwargs: {"content_complete": 1}
    )
    result = _verify(directory)
    assert result.status == "complete"
    assert result.observed["records"] == expected_total
    assert result.issues == ()


@pytest.mark.parametrize("invalid", [None, [], {}, "counts", "missing", "extra", True, 0, -1, 1.5])
def test_invalid_v2_module_counts_are_refused_before_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, invalid: Any
) -> None:
    from operations.sample.verification import run as verifier

    counts: Any = _recorded_counts()
    if invalid == "missing":
        counts.pop("warehouses")
    elif invalid == "extra":
        counts["unknown"] = 1
    elif isinstance(invalid, (bool, int, float)):
        counts["warehouses"] = invalid
    else:
        counts = invalid
    directory = tmp_path / ("a" * 32)
    _manifest(directory, **_v2(module_counts=counts))
    monkeypatch.setattr(
        verifier, "SampleClient", lambda *_args: pytest.fail("Invalid evidence reached network")
    )
    with pytest.raises(SampleVerificationError, match="module counts"):
        _verify(directory)


@pytest.mark.parametrize("version", [True, False, 1.0, 2.0, 3, "2"])
def test_unsupported_versions_are_refused_before_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, version: Any
) -> None:
    from operations.sample.verification import run as verifier

    directory = tmp_path / ("a" * 32)
    _manifest(directory, schema_version=version)
    monkeypatch.setattr(
        verifier, "SampleClient", lambda *_args: pytest.fail("Invalid evidence reached network")
    )
    with pytest.raises(SampleVerificationError, match="schema"):
        _verify(directory)


@pytest.mark.parametrize(
    "changes",
    [{"organization": "unknown"}, {"organization": None}, {"span": ""}, {"sampling_scope": None}],
)
def test_incomplete_pack_metadata_is_refused_before_network(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, changes: dict[str, Any]
) -> None:
    from operations.sample.verification import run as verifier

    directory = tmp_path / ("a" * 32)
    _manifest(directory, **_v2(**changes))
    monkeypatch.setattr(
        verifier, "SampleClient", lambda *_args: pytest.fail("Invalid evidence reached network")
    )
    with pytest.raises(SampleVerificationError, match="organization metadata"):
        _verify(directory)
