"""Build the frontend image using public values from the generated env file."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

PUBLIC_BUILD_KEYS = (
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED",
)
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
CommandRunner = Callable[..., subprocess.CompletedProcess[object]]


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse the generated dotenv projection without evaluating shell syntax."""

    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        raise ValueError(f"Cannot read generated frontend environment: {path}") from error
    for line_number, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            raise ValueError(f"Invalid generated environment line {line_number}")
        name, raw_value = line.split("=", 1)
        name = name.strip()
        if not _ENV_NAME.fullmatch(name):
            raise ValueError(f"Invalid generated environment key on line {line_number}")
        if name in values:
            raise ValueError(f"Duplicate generated environment key: {name}")
        value = raw_value.strip()
        if value.startswith('"'):
            try:
                decoded = json.loads(value)
            except json.JSONDecodeError as error:
                raise ValueError(f"Invalid generated environment value: {name}") from error
            if not isinstance(decoded, str) or not value.endswith('"'):
                raise ValueError(f"Invalid generated environment value: {name}")
            value = decoded
        elif len(value) >= 2 and value[0] == "'" and value[-1] == "'":
            value = value[1:-1]
        values[name] = value
    return values


def public_build_values(path: Path) -> dict[str, str]:
    values = parse_env_file(path)
    missing = [name for name in PUBLIC_BUILD_KEYS if not values.get(name, "").strip()]
    if missing:
        raise ValueError("Missing public frontend build values: " + ", ".join(missing))
    return {name: values[name] for name in PUBLIC_BUILD_KEYS}


def _project_environment(root: Path, run: CommandRunner) -> int:
    result = run(
        [
            "uv",
            "run",
            "--directory",
            "backend",
            "python",
            "../scripts/environment.py",
            "frontend",
        ],
        cwd=root,
        check=False,
    )
    return int(result.returncode)


def build_command(root: Path, env_file: Path, tag: str) -> list[str]:
    """Build a Docker command; public values are passed as argv, never shell code."""

    values = public_build_values(env_file)
    command = ["docker", "build"]
    for name in PUBLIC_BUILD_KEYS:
        command.extend(("--build-arg", f"{name}={values[name]}"))
    command.extend(
        (
            "--file",
            "infra/docker/frontend.Dockerfile",
            "--tag",
            tag,
            ".",
        )
    )
    del root  # Kept in the signature so callers can construct relative paths consistently.
    return command


def build_image(
    root: Path,
    env_file: Path,
    tag: str,
    *,
    run: CommandRunner | None = None,
) -> int:
    """Ensure projection exists, then build the image and preserve Docker's status."""

    command_runner = run or subprocess.run
    try:
        if not env_file.exists():
            projection_status = _project_environment(root, command_runner)
            if projection_status != 0:
                return projection_status
        command = build_command(root, env_file, tag)
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    try:
        result = command_runner(command, cwd=root, check=False)
    except OSError as error:
        print(f"Docker build could not run: {error}", file=sys.stderr)
        return 127
    return int(result.returncode)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--env-file",
        type=Path,
        default=Path("frontend/.env.local"),
        help="Generated frontend dotenv projection",
    )
    parser.add_argument("--tag", default="openslate-frontend:ci")
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[1]
    env_file = args.env_file if args.env_file.is_absolute() else root / args.env_file
    return build_image(root, env_file, args.tag)


if __name__ == "__main__":
    raise SystemExit(main())
