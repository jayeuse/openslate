"""Inputs a disposable Supabase stack writes before Compose creates it."""

import re
import subprocess
from pathlib import Path

import pytest
import yaml

from tests import supabase_runtime
from tests.postgres_runtime import DisposablePostgres

BASE_COMPOSE = supabase_runtime.COMPOSE_DIRECTORY / "compose.yaml"
DURABILITY_OFF = ["-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"]


class _StopAfterCreate(Exception):
    pass


def _env_values(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        name, _, value = line.partition("=")
        values[name] = value.strip('"')
    return values


def _start_until_create(tmp_path: Path, monkeypatch, block: int, **options) -> DisposablePostgres:
    """Run start() with fake Docker until Compose would create the stack."""
    log = (tmp_path / f"process-{block}.log").open("w")
    runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log, **options)
    ports = iter((49152, 49153, 49154, 49155))
    calls: list[int] = []

    def available_port() -> int:
        calls.append(1)
        return next(ports)

    def compose(arguments, **_kwargs):
        if arguments == ["create"]:
            raise _StopAfterCreate
        return subprocess.CompletedProcess(arguments, 0, "")

    monkeypatch.setattr(supabase_runtime, "_available_port", available_port)
    monkeypatch.setattr(runtime, "_compose", compose)
    monkeypatch.setattr(runtime, "_free_network_block", lambda: block)
    with pytest.raises(_StopAfterCreate):
        runtime.start()
    log.close()
    # db, gateway, mail, and the private Comms publisher; never a free port for templates
    assert len(calls) == 4
    return runtime


def test_backend_only_stacks_get_a_fixed_template_port_from_their_network_block(
    tmp_path: Path, monkeypatch
) -> None:
    (tmp_path / "one").mkdir()
    (tmp_path / "two").mkdir()
    first = _start_until_create(tmp_path / "one", monkeypatch, 7)
    second = _start_until_create(tmp_path / "two", monkeypatch, 8)

    base = supabase_runtime.TEMPLATE_PORT_BASE
    assert (first.template_port, second.template_port) == (base + 7, base + 8)
    # Below the ephemeral ranges (Linux 32768+, macOS and Windows 49152+).
    assert base + 254 < 30000  # also below the Kubernetes NodePort range
    url = _env_values(first.env_file)["AUTH_TEMPLATE_BASE_URL"]
    assert url == f"http://host.docker.internal:{base + 7}/api/auth/email-templates"


def test_a_stack_beside_the_runner_api_keeps_its_template_port(
    tmp_path: Path, monkeypatch
) -> None:
    runtime = _start_until_create(tmp_path, monkeypatch, 7, template_port=8008)

    assert runtime.template_port == 8008
    url = _env_values(runtime.env_file)["AUTH_TEMPLATE_BASE_URL"]
    assert url == "http://host.docker.internal:8008/api/auth/email-templates"


def _interpolations_without_defaults(arguments: list[str]) -> list[str]:
    # The base file requires the instance ID (`${NAME:?message}`); the overlay names it.
    return [re.sub(r"\$\{(\w+)(?::?[-?+][^}]*)?\}", r"${\1}", value) for value in arguments]


def test_the_test_db_command_is_the_base_command_plus_only_the_durability_flags(
    tmp_path: Path,
) -> None:
    with (tmp_path / "process.log").open("w") as log:
        runtime = DisposablePostgres(tmp_path, "a" * 32, {"PATH": "test"}, log)
        runtime.port, runtime.api_port, runtime.mail_port = 49152, 49153, 49154
        runtime.template_port, runtime.network_block = 29007, 7
        runtime._write_inputs()

    base = yaml.safe_load(BASE_COMPOSE.read_text(encoding="utf-8"))["services"]["db"]["command"]
    overlay = yaml.safe_load(runtime.overlay_file.read_text(encoding="utf-8"))
    command = overlay["services"]["db"]["command"]

    assert _interpolations_without_defaults(command) == (
        _interpolations_without_defaults(base) + DURABILITY_OFF
    )
