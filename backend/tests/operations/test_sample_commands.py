"""CLI safety contracts independent of network/database workflows."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from operations import seed_sample_data as commands


def test_populate_requires_private_run_destination() -> None:
    with pytest.raises(SystemExit) as stopped:
        commands._parser().parse_args(["populate"])
    assert stopped.value.code == 2
    args = commands._parser().parse_args(
        [
            "populate",
            "--run-root",
            "/private/demo",
            "--profile",
            "small",
            "--admin-password-file",
            "/private/admin.json",
        ]
    )
    assert args.run_root == Path("/private/demo")
    assert args.admin_password_file == Path("/private/admin.json")


def test_verify_requires_existing_run_not_a_new_profile() -> None:
    with pytest.raises(SystemExit) as stopped:
        commands._parser().parse_args(["verify", "--profile", "standard"])
    assert stopped.value.code == 2
    args = commands._parser().parse_args(["verify", "--run-directory", "/private/demo/run"])
    assert args.run_directory == Path("/private/demo/run")
    assert not hasattr(args, "profile")


@pytest.mark.parametrize("orphan_kind", ["storage_objects", "provider_accounts"])
def test_populate_refuses_orphans_before_password_or_run_creation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    orphan_kind: str,
) -> None:
    monkeypatch.setattr(
        commands,
        "_local_preflight",
        lambda *_args: (
            {"storage_objects": 0, "provider_accounts": 0, orphan_kind: 1, "admin_id": "admin-a"},
            "http://api",
            "http://mail",
        ),
    )
    monkeypatch.setattr(
        commands,
        "_environment_values",
        lambda: pytest.fail("credentials must not be read for an unsafe baseline"),
    )
    root = tmp_path / "new-run-root"
    result = commands.main(["populate", "--run-root", str(root)])
    assert result == 2
    assert orphan_kind.split("_")[0] in capsys.readouterr().err.lower()
    assert not root.exists()


def test_population_accepts_the_ready_core_components(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/health":
            return httpx.Response(200, headers={"X-OpenSlate-Instance": "owned"})
        return httpx.Response(
            200,
            json={
                "status": "ready",
                "components": {
                    name: {"status": "ready"}
                    for name in ("database", "auth", "storage", "smtp")
                },
            },
        )

    client_type = httpx.Client
    monkeypatch.setattr(
        commands.httpx,
        "Client",
        lambda **kwargs: client_type(transport=httpx.MockTransport(handler), **kwargs),
    )
    assert commands._assert_api_identity("http://localhost:8000", "owned")["status"] == "ready"


ADMIN_ID = "0190a000-0000-7000-8000-000000000001"
EXISTING_ORG = "0190a000-0000-7000-8000-0000000000aa"
CREATED_ORG = "0190a000-0000-7000-8000-0000000000bb"
EXISTING_PARTNER = "0190a000-0000-7000-8000-0000000000ac"
CREATED_PARTNER = "0190a000-0000-7000-8000-0000000000bc"


def _populate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, organization: dict[str, object]
) -> tuple[int, list[Any], list[str], list[Any]]:
    from operations.sample.population import run as population

    packs: list[Any] = []
    events: list[str] = []
    populated: list[Any] = []

    def preflight(pack: Any) -> tuple[dict[str, object], str, str]:
        packs.append(pack)
        report = {"admin_id": ADMIN_ID, "storage_objects": 0, "provider_accounts": 0}
        return {**report, **organization}, "http://api", "http://mail"

    def password(*_args: object) -> str:
        events.append("password")
        return "fixture-password"

    def create(
        _values: object, _target: object, pack: Any, admin_id: object, *, partner: bool = False
    ) -> str:
        events.append(f"create:{pack.identity.key}:{admin_id}:{'partner' if partner else 'pack'}")
        return CREATED_PARTNER if partner else CREATED_ORG

    def populate(**kwargs: Any) -> object:
        populated.append((kwargs["organization_id"], kwargs["partner_organization_id"]))
        return population.SamplePopulationReport("complete", tmp_path, (), {})

    monkeypatch.setattr(commands, "_local_preflight", preflight)
    monkeypatch.setattr(
        commands,
        "_environment_values",
        lambda: ({}, None, "admin@example.test", "http://api", "http://ui", 2.0),
    )
    monkeypatch.setattr(commands, "build_dataset", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(commands, "_print_plan", lambda *_args: None)
    monkeypatch.setattr(commands, "create_sample_organization", create)
    monkeypatch.setattr(population, "read_admin_password", password)
    monkeypatch.setattr(population, "populate_sample_data", populate)
    status = commands.main(
        ["populate", "--organization", "school", "--run-root", str(tmp_path),
         "--admin-password-file", str(tmp_path / "unused"), "--anchor-date", "2026-09-30"]
    )
    return status, packs, events, populated


def test_populate_reuses_the_pack_organization_found_by_slug(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    status, packs, events, populated = _populate(
        monkeypatch,
        tmp_path,
        {"organization_id": EXISTING_ORG, "partner_organization_id": EXISTING_PARTNER},
    )

    assert status == 0
    assert [pack.identity.key for pack in packs] == ["school"]
    assert events == ["password"]
    assert populated == [(EXISTING_ORG, EXISTING_PARTNER)]


def test_populate_creates_the_missing_pack_organization_after_the_password(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    status, _packs, events, populated = _populate(
        monkeypatch, tmp_path, {"organization_id": None, "partner_organization_id": None}
    )

    assert status == 0
    assert events == [
        "password", f"create:school:{ADMIN_ID}:pack", f"create:school:{ADMIN_ID}:partner"
    ]
    assert populated == [(CREATED_ORG, CREATED_PARTNER)]


@pytest.mark.parametrize("usage", ["organization_members", "organization_records"])
def test_populate_refuses_a_pack_organization_that_holds_sample_data(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    usage: str,
) -> None:
    status, _packs, events, populated = _populate(
        monkeypatch, tmp_path, {"organization_id": EXISTING_ORG, usage: 1}
    )

    assert status == 2
    assert "already holds sample data" in capsys.readouterr().err
    assert events == [] and populated == []
