"""Configuration and CLI guard contracts for the reset utility."""
from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import Mock

import pytest

from scripts import reset_application_data as reset

from .support import (
    DATABASE_PASSWORD,
    DATABASE_URL,
    EMAIL,
    ROOT,
    STATUS_PASSWORD,
    STATUS_URL,
)


def test_local_database_url_accepts_only_the_exact_loopback_target() -> None:
    reset.validate_local_database_url(DATABASE_URL)
    reset.validate_local_database_url(
        f"postgresql+psycopg://postgres:{DATABASE_PASSWORD}@127.0.0.1:54322/postgres"
    )


@pytest.mark.parametrize(
    "value",
    [
        f"postgresql://postgres:{DATABASE_PASSWORD}@localhost:54322/postgres",
        f"postgresql://postgres:{DATABASE_PASSWORD}@::1:54322/postgres",
        f"postgresql://postgres:{DATABASE_PASSWORD}@database.example:54322/postgres",
        f"postgresql://postgres:{DATABASE_PASSWORD}@192.0.2.10:54322/postgres",
        f"postgresql://postgres:{DATABASE_PASSWORD}@127.0.0.1:54321/postgres",
        f"postgresql://postgres:{DATABASE_PASSWORD}@127.0.0.1:54322/other",
        "postgresql://@127.0.0.1:54322/postgres",
        "postgresql://127.0.0.1:54322/postgres",
        "not-a-database-url",
    ],
)
def test_local_database_url_rejects_nonlocal_or_malformed_forms(value: str) -> None:
    with pytest.raises(reset.ResetError) as error:
        reset.validate_local_database_url(value)

    assert DATABASE_PASSWORD not in str(error.value)


def test_supabase_status_output_is_parsed_in_memory_and_not_printed(
    capsys: pytest.CaptureFixture[str],
) -> None:
    runner = Mock(
        return_value=subprocess.CompletedProcess(
            ["supabase", "status", "-o", "env"],
            0,
            stdout=(
                "API_URL='http://127.0.0.1:54321'\n"
                f"DB_URL='{STATUS_URL}'\n"
                "PRIVATE_METADATA='must stay private'\n"
            ),
            stderr="",
        )
    )

    assert reset.read_supabase_status_database_url(runner) == STATUS_URL
    assert reset.parse_supabase_status_database_url(f"DB_URL='{STATUS_URL}'\n") == STATUS_URL
    assert capsys.readouterr().out == ""
    runner.assert_called_once()
    command = runner.call_args.args[0]
    assert command == ["supabase", "status", "-o", "env"]
    assert runner.call_args.kwargs["capture_output"] is True
    assert runner.call_args.kwargs["text"] is True
    assert runner.call_args.kwargs["cwd"] == ROOT


def test_status_command_receives_only_path_and_no_environment_secrets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = "/private/test-bin"
    sentinel = "status-environment-secret"
    monkeypatch.setenv("PATH", path)
    monkeypatch.setenv("RESET_TEST_SENTINEL", sentinel)
    runner = Mock(
        return_value=subprocess.CompletedProcess(
            ["supabase", "status", "-o", "env"],
            0,
            stdout=f"DB_URL='{STATUS_URL}'\n",
            stderr="",
        )
    )

    assert reset.read_supabase_status_database_url(runner) == STATUS_URL

    environment = runner.call_args.kwargs["env"]
    assert environment == {"PATH": path}
    assert sentinel not in environment.values()


def test_status_command_fails_closed_when_path_is_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PATH", raising=False)
    runner = Mock(
        return_value=subprocess.CompletedProcess(
            ["supabase", "status", "-o", "env"],
            0,
            stdout=f"DB_URL='{STATUS_URL}'\n",
            stderr="",
        )
    )

    with pytest.raises(reset.ResetError):
        reset.read_supabase_status_database_url(runner)

    runner.assert_not_called()


def test_status_failures_and_url_mismatches_do_not_expose_passwords() -> None:
    runner = Mock(
        side_effect=subprocess.CalledProcessError(
            1,
            ["supabase", "status", "-o", "env"],
            output=f"status output contains {STATUS_PASSWORD}",
            stderr=f"stderr contains {STATUS_PASSWORD}",
        )
    )
    with pytest.raises(reset.ResetError) as status_error:
        reset.read_supabase_status_database_url(runner)
    assert STATUS_PASSWORD not in str(status_error.value)

    with pytest.raises(reset.ResetError) as mismatch_error:
        reset.validate_local_database_url(DATABASE_URL, expected_url=STATUS_URL)
    assert DATABASE_PASSWORD not in str(mismatch_error.value)
    assert STATUS_PASSWORD not in str(mismatch_error.value)


@pytest.mark.parametrize(
    "output",
    [
        "API_URL=http://127.0.0.1:54321\n",
        "DB_URL=\n",
        "DB_URL='not a postgres URL'\n",
        "DB_URL=postgresql://one@127.0.0.1:54322/postgres\n"
        "DB_URL=postgresql://two@127.0.0.1:54322/postgres\n",
    ],
)
def test_status_parser_rejects_missing_or_ambiguous_database_url(output: str) -> None:
    with pytest.raises(reset.ResetError):
        reset.parse_supabase_status_database_url(output)


def test_local_project_guard_requires_the_expected_open_slate_config(tmp_path: Path) -> None:
    reset.validate_local_project(ROOT)

    supabase_directory = tmp_path / "supabase"
    supabase_directory.mkdir()
    (supabase_directory / "config.toml").write_text(
        'project_id = "not-openslate"\n\n[db]\nport = 54322\n',
        encoding="utf-8",
    )
    with pytest.raises(reset.ResetError):
        reset.validate_local_project(tmp_path)

    (supabase_directory / "config.toml").write_text(
        'project_id = "openslate"\n\n[db]\nport = 54321\n',
        encoding="utf-8",
    )
    with pytest.raises(reset.ResetError):
        reset.validate_local_project(tmp_path)


def test_required_environment_never_falls_back_to_database_url() -> None:
    assert reset.required_environment(
        {"MIGRATION_DATABASE_URL": DATABASE_URL, "SAMPLE_EMAIL": EMAIL}
    ) == (DATABASE_URL, EMAIL)

    with pytest.raises(reset.ResetError, match="MIGRATION_DATABASE_URL"):
        reset.required_environment({"DATABASE_URL": DATABASE_URL, "SAMPLE_EMAIL": EMAIL})


@pytest.mark.parametrize(
    "environment",
    [
        {"MIGRATION_DATABASE_URL": DATABASE_URL},
        {"MIGRATION_DATABASE_URL": DATABASE_URL, "SAMPLE_EMAIL": "   "},
        {"MIGRATION_DATABASE_URL": "   ", "SAMPLE_EMAIL": EMAIL},
    ],
)
def test_required_environment_rejects_missing_or_blank_values(
    environment: dict[str, str],
) -> None:
    with pytest.raises(reset.ResetError):
        reset.required_environment(environment)


def test_cli_defaults_to_dry_run_and_has_no_secret_options() -> None:
    parser = reset._parser()
    assert parser.parse_args([]).execute is False
    assert parser.parse_args(["--execute"]).execute is True

    for option in ("--database-url", "--sample-email"):
        with pytest.raises(SystemExit):
            parser.parse_args([option, "secret-value"])

