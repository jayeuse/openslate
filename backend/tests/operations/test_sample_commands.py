"""CLI safety contracts independent of network/database workflows."""

from __future__ import annotations

from pathlib import Path

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
        lambda: (
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


def test_nonfile_population_does_not_require_optional_scanner(
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
                    **{
                        name: {"status": "ready"}
                        for name in ("database", "auth", "storage", "smtp")
                    },
                    "scanner": {"status": "unavailable", "required": False},
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
