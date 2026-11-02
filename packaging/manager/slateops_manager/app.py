"""Command-line entrypoint for the unprivileged Gate 0 desktop shell."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import ManagerConfigError, read_public_config
from .ui import open_manager_window


def default_config_path() -> Path:
    """Locate the public config beside the host-native one-folder application."""

    executable = Path(sys.executable).resolve()
    if sys.platform == "darwin" and executable.parent.name == "MacOS":
        return executable.parent.parent / "Resources" / "manager.json"
    return executable.parent / "manager.json"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        help="Public manager configuration path (for development validation only)",
    )
    parser.add_argument("--version", action="store_true", help="Print the bundled manager version")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config_path = args.config or default_config_path()
    try:
        manager_config = read_public_config(config_path)
    except ManagerConfigError as error:
        print(str(error), file=sys.stderr)
        return 2
    if args.version:
        print(manager_config.version)
        return 0
    open_manager_window(manager_config)
    return 0
