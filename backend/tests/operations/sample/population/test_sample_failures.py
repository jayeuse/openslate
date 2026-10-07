from __future__ import annotations

import json
import secrets
from dataclasses import replace
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from operations import seed_sample_data as seed_operator
from operations.sample.client import SampleClientError
from operations.sample.packs import get_pack
from operations.sample.population import run as population
from operations.sample.population.content import SampleContentError
from operations.sample.population.run import SamplePopulationError
from operations.sample.verification.core import failure_report


def _preflight() -> tuple[dict[str, object], str, str]:
    return (
        {
            "instance": "local-test-instance",
            "alembic_head": "head",
            "admin_eligible": True,
            "admin_id": "admin-id",
            "storage_objects": 0,
            "provider_accounts": 0,
        },
        "http://127.0.0.1:8000",
        "http://127.0.0.1:8025",
    )


def test_failure_report_includes_only_approved_operator_messages() -> None:
    cases = (
        (
            SampleContentError("GET /api/boards returned invalid pagination"),
            "GET /api/boards returned invalid pagination",
        ),
        (
            SamplePopulationError("The private API journal is invalid or ambiguous"),
            "The private API journal is invalid or ambiguous",
        ),
        (
            ValueError("Sample journal mappings accept identifier values only"),
            "Sample journal mappings accept identifier values only",
        ),
    )

    for error, expected in cases:
        report = failure_report("activity", error)
        assert report["message"] == expected


def test_failure_report_keeps_untrusted_messages_and_exception_attributes_private() -> None:
    error = RuntimeError("password=private-password admin@example.test server body")
    error.attempt_id = "password=private-password"  # type: ignore[attr-defined]
    error.request_id = "admin@example.test"  # type: ignore[attr-defined]
    error.status_code = "authorization=private-token"  # type: ignore[attr-defined]

    report = failure_report("activity", error)
    serialized = json.dumps(report)

    assert report["message"] == "The operation stopped; reconcile server state before rebuilding."
    assert report["stage"] == "activity"
    assert "attempt_id" not in report
    assert "request_id" not in report
    assert "status_code" not in report
    assert "private-password" not in serialized
    assert "admin@example.test" not in serialized
    assert "private-token" not in serialized
    assert "server body" not in serialized


def test_failure_report_keeps_unapproved_value_errors_generic() -> None:
    report = failure_report("activity", ValueError("private field value"))

    assert report["message"] == "The operation stopped; reconcile server state before rebuilding."


def test_failure_report_retains_valid_sample_request_ids_for_reconciliation() -> None:
    error = SampleClientError(
        "The write could not be confirmed",
        attempt_id="00000000-0000-0000-0000-000000000001",
        request_id="00000000-0000-0000-0000-000000000002",
        status_code=503,
    )

    report = failure_report("activity", error)

    assert report["attempt_id"] == "00000000-0000-0000-0000-000000000001"
    assert report["request_id"] == "00000000-0000-0000-0000-000000000002"
    assert report["status_code"] == "503"
    assert "The write could not be confirmed" not in report["message"]


def test_failure_report_keeps_the_stage_and_step() -> None:
    report = failure_report(
        "activity",
        SamplePopulationError("Record writer mapping is incomplete"),
        step="record_create",
    )

    assert report["stage"] == "activity"
    assert report["step"] == "record_create"


def test_cli_displays_only_safe_operator_failure_messages(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def fail_preflight() -> tuple[dict[str, object], str, str]:
        raise SampleContentError("GET /api/boards returned HTTP 503")

    monkeypatch.setattr(seed_operator, "_local_preflight", fail_preflight)
    assert seed_operator.main(["plan", "--anchor-date", "2026-09-30"]) == 2
    assert "GET /api/boards returned HTTP 503" in capsys.readouterr().err

    def fail_unexpectedly() -> tuple[dict[str, object], str, str]:
        raise RuntimeError("password=private-password server body")

    monkeypatch.setattr(seed_operator, "_local_preflight", fail_unexpectedly)
    assert seed_operator.main(["plan", "--anchor-date", "2026-09-30"]) == 2
    error_output = capsys.readouterr().err
    assert "password=private-password" not in error_output
    assert "server body" not in error_output


def test_plan_without_seed_draws_once_per_invocation_and_explicit_seed_wins(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    drawn = iter((731, 942))
    random_calls: list[int] = []
    planned: list[int] = []
    built: list[int] = []

    def draw_seed(bits: int) -> int:
        random_calls.append(bits)
        return next(drawn)

    def build(
        profile: str,
        seed: int,
        anchor: date,
        *,
        organization: object,
        host_acceptance: bool = False,
    ) -> object:
        built.append(seed)
        return SimpleNamespace(seed=seed)

    monkeypatch.setattr(secrets, "randbits", draw_seed)
    monkeypatch.setattr(seed_operator, "_local_preflight", _preflight)
    monkeypatch.setattr(seed_operator, "build_dataset", build)
    monkeypatch.setattr(
        seed_operator, "_print_plan", lambda dataset, *_args: planned.append(dataset.seed)
    )

    assert seed_operator.main(["plan", "--anchor-date", "2026-09-30"]) == 0
    assert seed_operator.main(["plan", "--anchor-date", "2026-09-30"]) == 0
    assert seed_operator.main(["plan", "--seed", "57", "--anchor-date", "2026-09-30"]) == 0

    assert len(random_calls) == 2
    assert planned == [731, 942, 57]
    assert built == planned


def test_populate_uses_one_generated_seed_for_plan_and_population(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    random_calls: list[int] = []
    planned: list[int] = []
    populated: list[int] = []

    def draw_seed(bits: int) -> int:
        random_calls.append(bits)
        return 1_982_731

    def build(
        profile: str,
        seed: int,
        anchor: date,
        *,
        organization: object,
        host_acceptance: bool = False,
    ) -> object:
        planned.append(seed)
        return SimpleNamespace(seed=seed)

    def populate(**kwargs: Any) -> object:
        populated.append(kwargs["seed"])
        return SimpleNamespace(status="complete", run_directory=tmp_path, issues=())

    from operations.sample.population import run as sample_population

    monkeypatch.setattr(secrets, "randbits", draw_seed)
    monkeypatch.setattr(seed_operator, "_local_preflight", _preflight)
    monkeypatch.setattr(
        seed_operator,
        "_environment_values",
        lambda: (
            {},
            None,
            "admin@example.test",
            "http://127.0.0.1:8000",
            "http://127.0.0.1:3000",
            2.0,
        ),
    )
    monkeypatch.setattr(sample_population, "read_admin_password", lambda *_args: "synthetic")
    monkeypatch.setattr(sample_population, "populate_sample_data", populate)
    monkeypatch.setattr(seed_operator, "build_dataset", build)
    monkeypatch.setattr(seed_operator, "_print_plan", lambda dataset, *_args: None)

    command = [
        "populate",
        "--run-root",
        str(tmp_path),
        "--admin-password-file",
        str(tmp_path / "ignored-by-test-double"),
        "--anchor-date",
        "2026-09-30",
    ]
    result = seed_operator.main(command)
    explicit_result = seed_operator.main([*command, "--seed", "603"])

    assert result == 0
    assert explicit_result == 0
    assert len(random_calls) == 1
    assert planned == populated == [1_982_731, 603]


def test_verify_command_has_no_seed_override() -> None:
    args = seed_operator._parser().parse_args(["verify", "--run-directory", "/private/run"])

    assert not hasattr(args, "seed")
    with pytest.raises(SystemExit):
        seed_operator._parser().parse_args(
            ["verify", "--run-directory", "/private/run", "--seed", "101"]
        )


def test_verifier_rebuilds_from_the_recorded_seed_without_drawing_randomness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from operations.sample.verification import run as verifier

    pack = get_pack("harbor")
    recorded_seed = 8_231_440
    manifest = {
        "status": "complete",
        "profile": "small",
        "seed": recorded_seed,
        "anchor_date": "2026-09-30",
        "mappings": {},
        "actor_ids": {},
        "started_at": "2026-09-30T00:00:00Z",
        "finished_at": "2026-09-30T01:00:00Z",
        "expected_failures": [],
        "people": {},
        "content_counts": {},
        "history_skipped": [],
    }
    built_seeds: list[int] = []

    class FakeClient:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def __enter__(self) -> FakeClient:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def login(self, *_args: object) -> httpx.Response:
            return httpx.Response(200)

        def request(self, _method: str, path: str) -> httpx.Response:
            if path == "/api/auth/me":
                return httpx.Response(200, json={"id": "admin-id"})
            assert path == "/api/auth/logout"
            return httpx.Response(204)

    monkeypatch.setattr(verifier, "read_run_manifest", lambda *_args: manifest)
    monkeypatch.setattr(
        verifier,
        "_manifest_plan",
        lambda _manifest: (pack, dict(pack.catalog.counts_by_profile["small"])),
    )
    monkeypatch.setattr(
        verifier,
        "build_dataset",
        lambda _profile, seed, *_args, **_kwargs: (
            built_seeds.append(seed) or SimpleNamespace(organization=pack)
        ),
    )
    monkeypatch.setattr(verifier, "SampleClient", FakeClient)
    monkeypatch.setattr(verifier, "verify_records_and_relationships", lambda *_a, **_k: ({}, []))
    monkeypatch.setattr(verifier, "verify_history", lambda *_a, **_k: ({}, []))
    monkeypatch.setattr(verifier, "verify_rejections", lambda *_a, **_k: ({}, []))
    monkeypatch.setattr(verifier, "_people_issues", lambda *_a, **_k: ({}, []))
    monkeypatch.setattr(verifier, "verify_configuration", lambda *_a, **_k: ({}, []))
    monkeypatch.setattr(verifier, "verify_content", lambda *_a, **_k: {"content_complete": 1})
    monkeypatch.setattr(verifier, "_verify_triggers", lambda *_a, **_k: ({}, []))
    monkeypatch.setattr(secrets, "randbits", lambda *_args: pytest.fail("verify drew a seed"))

    result = verifier.verify_sample_data(
        api_url="http://127.0.0.1:8000",
        origin="http://127.0.0.1:3000",
        admin_email="admin@example.test",
        expected_admin_id="admin-id",
        admin_password="synthetic",
        run_directory=Path("/private/run"),
    )

    assert result.status == "complete"
    assert built_seeds == [recorded_seed]


def test_population_manifest_records_the_selected_seed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pack = replace(get_pack("harbor"), phases=None)
    dataset_seed = 625
    dataset = SimpleNamespace(
        seed=dataset_seed,
        organization=pack,
        module_counts={"invoices": 1},
        records=(),
        edges=(),
    )
    from operations.sample.population import workflow as sample_population_workflow
    from operations.sample.verification import run as sample_run_verification
    from operations.sample.verification.run import SampleVerificationReport

    monkeypatch.setattr(population, "build_dataset", lambda *_args, **_kwargs: dataset)
    monkeypatch.setattr(sample_population_workflow, "_journal_mappings", lambda _path: {})
    monkeypatch.setattr(sample_population_workflow, "run_population", lambda **_kwargs: {})
    monkeypatch.setattr(
        sample_run_verification,
        "verify_sample_data",
        lambda **kwargs: SampleVerificationReport("complete", kwargs["run_directory"], {}, ()),
    )

    result = population.populate_sample_data(
        api_url="http://127.0.0.1:8000",
        origin="http://127.0.0.1:3000",
        mailpit_url="http://127.0.0.1:8025",
        admin_email="admin@example.test",
        expected_admin_id="admin-id",
        admin_password="synthetic",
        run_root=tmp_path,
        profile="small",
        seed=dataset_seed,
        anchor_date=date(2026, 9, 30),
        organization=pack,
    )

    manifest = json.loads((result.run_directory / "manifest.json").read_text())
    assert result.status == "complete"
    assert manifest["seed"] == dataset.seed == dataset_seed


def test_population_failure_records_safe_message_and_failed_stage(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pack = replace(get_pack("harbor"), phases=None)
    dataset = SimpleNamespace(
        seed=42,
        organization=pack,
        module_counts={"invoices": 1},
        records=(),
        edges=(),
    )
    from operations.sample.population import workflow as sample_population_workflow

    def fail_population(**kwargs: Any) -> dict[str, int]:
        kwargs["manifest"]["stage"] = "activity"
        raise SamplePopulationError("Record writer mapping is incomplete")

    monkeypatch.setattr(population, "build_dataset", lambda *_args, **_kwargs: dataset)
    monkeypatch.setattr(sample_population_workflow, "run_population", fail_population)
    monkeypatch.setattr(sample_population_workflow, "_journal_mappings", lambda _path: {})

    result = population.populate_sample_data(
        api_url="http://127.0.0.1:8000",
        origin="http://127.0.0.1:3000",
        mailpit_url="http://127.0.0.1:8025",
        admin_email="admin@example.test",
        expected_admin_id="admin-id",
        admin_password="synthetic",
        run_root=tmp_path,
        profile="small",
        seed=42,
        anchor_date=date(2026, 9, 30),
        organization=pack,
    )

    manifest = json.loads((result.run_directory / "manifest.json").read_text())
    assert result.status == "incomplete"
    assert manifest["failed_step"] == "activity"
    assert manifest["failure"]["stage"] == "activity"
    assert manifest["failure"]["message"] == "Record writer mapping is incomplete"
