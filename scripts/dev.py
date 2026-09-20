#!/usr/bin/env python3
"""Start and inspect OpenSlate's local development containers."""

from __future__ import annotations

import argparse
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Final

ROOT: Final = Path(__file__).resolve().parents[1]
ENVIRONMENT_HELPER: Final = ROOT / "scripts" / "environment.py"

_ACTIONS: Final[dict[str, tuple[str, ...]]] = {
    "db": ("up", "-d", "postgres"),
    "pgweb": ("--profile", "db-ui", "up", "-d", "--force-recreate", "pgweb"),
    "caddy": ("--profile", "gateway", "up", "-d", "--force-recreate", "caddy"),
    "containers": (
        "--profile",
        "db-ui",
        "--profile",
        "gateway",
        "up",
        "-d",
        "--force-recreate",
        "pgweb",
        "caddy",
    ),
    "status": ("--profile", "db-ui", "--profile", "gateway", "ps"),
    "stop": ("--profile", "db-ui", "--profile", "gateway", "stop"),
}

_STOP_TARGETS: Final[dict[str, tuple[str, ...]]] = {
    "db": ("stop", "postgres"),
    "pgweb": ("--profile", "db-ui", "stop", "pgweb"),
    "caddy": ("--profile", "gateway", "stop", "caddy"),
    "containers": _ACTIONS["stop"],
}

CommandRunner = Callable[..., subprocess.CompletedProcess[object]]


def build_command(action: str, target: str | None = None) -> list[str]:
    """Expand one public developer action into the canonical environment helper."""
    if action != "stop" and target is not None:
        raise ValueError("only stop accepts a container target")
    arguments = _STOP_TARGETS[target] if target is not None else _ACTIONS[action]
    return [
        "uv",
        "run",
        "--directory",
        str(ROOT / "backend"),
        "python",
        str(ENVIRONMENT_HELPER),
        "compose",
        *arguments,
    ]


def main(
    argv: Sequence[str] | None = None,
    *,
    runner: CommandRunner = subprocess.run,
) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "action",
        choices=tuple(_ACTIONS),
        help="container group to start, or status/stop",
    )
    parser.add_argument(
        "target",
        nargs="?",
        choices=tuple(_STOP_TARGETS),
        help="optional container target accepted by stop",
    )
    options = parser.parse_args(argv)
    if options.action != "stop" and options.target is not None:
        parser.error("a container target can only follow stop")
    return runner(
        build_command(options.action, options.target), cwd=ROOT, check=False
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
