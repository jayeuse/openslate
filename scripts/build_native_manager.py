"""Build one unsigned, host-native Gate 0 OpenSlate Manager artifact."""

from __future__ import annotations

import argparse
import contextlib
import json
import platform
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANAGER_ROOT = ROOT / "packaging/manager"
NOTICE = MANAGER_ROOT / "THIRD_PARTY_NOTICES.md"
APP_NAME = "OpenSlate Manager"
SUPPORTED_ARCHITECTURES = {
    "darwin": frozenset({"arm64", "x86_64"}),
    "win32": frozenset({"amd64", "arm64"}),
}
CommandRunner = Callable[..., subprocess.CompletedProcess[object]]


class BuildConfigurationError(ValueError):
    """Raised before any build starts when a host build is unsupported or unsafe."""


def resolve_output_directory(
    output_directory: Path, *, current_directory: Path | None = None
) -> Path:
    """Resolve one caller-provided output location before changing the process cwd."""

    caller_directory = (current_directory or Path.cwd()).resolve()
    candidate = (
        output_directory if output_directory.is_absolute() else caller_directory / output_directory
    )
    resolved = candidate.resolve()
    if resolved == Path(resolved.anchor):
        raise BuildConfigurationError("Output directory cannot be a filesystem root")
    return resolved


def host_platform() -> tuple[str, str]:
    system = sys.platform
    machine = platform.machine().lower()
    if machine == "x86-64":
        machine = "x86_64"
    if machine == "aarch64":
        machine = "arm64"
    return system, machine


def validate_host_platform() -> tuple[str, str]:
    system, machine = host_platform()
    supported = SUPPORTED_ARCHITECTURES.get(system)
    if supported is None or machine not in supported:
        raise BuildConfigurationError(
            "Native manager builds require a supported Windows or macOS host architecture"
        )
    return system, machine


def build_command(
    *,
    source_root: Path,
    output_directory: Path,
    work_directory: Path,
    spec_directory: Path,
) -> list[str]:
    """Construct an onedir PyInstaller command for this host only."""

    return [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onedir",
        "--windowed",
        "--name",
        APP_NAME,
        "--paths",
        str(MANAGER_ROOT),
        "--distpath",
        str(output_directory),
        "--workpath",
        str(work_directory),
        "--specpath",
        str(spec_directory),
        str(source_root / "packaging/manager/main.py"),
    ]


def write_public_config(path: Path, manager_config: object) -> None:
    """Write only the validated public manager configuration."""

    from openslate_manager.config import ManagerConfig

    if not isinstance(manager_config, ManagerConfig):
        raise TypeError("manager_config must be a ManagerConfig")
    path.write_text(
        json.dumps({"origin": manager_config.origin, "version": manager_config.version}, indent=2)
        + "\n",
        encoding="utf-8",
    )


def artifact_path(output_directory: Path, system: str) -> Path:
    return output_directory / (f"{APP_NAME}.app" if system == "darwin" else APP_NAME)


def remove_macos_non_bundle_output(output_directory: Path, bundle: Path) -> None:
    """Remove PyInstaller's duplicate macOS onedir output after the app bundle exists."""

    duplicate = output_directory / APP_NAME
    if duplicate == bundle or not duplicate.exists():
        return
    if not duplicate.is_dir():
        raise BuildConfigurationError(f"Unexpected macOS PyInstaller output: {duplicate}")
    shutil.rmtree(duplicate)


def install_public_files(artifact: Path, system: str, manager_config: object) -> None:
    """Place public configuration and notices inside the generated one-folder artifact."""

    if not artifact.is_dir():
        raise BuildConfigurationError(
            f"PyInstaller did not create the expected artifact: {artifact}"
        )
    if system == "darwin":
        destination = artifact / "Contents/Resources"
    else:
        destination = artifact
    destination.mkdir(parents=True, exist_ok=True)
    write_public_config(destination / "manager.json", manager_config)
    shutil.copyfile(NOTICE, destination / NOTICE.name)


def verify_artifact(artifact: Path, system: str) -> None:
    executable = (
        artifact / "Contents/MacOS" / APP_NAME
        if system == "darwin"
        else artifact / f"{APP_NAME}.exe"
    )
    config_path = (
        artifact / "Contents/Resources/manager.json"
        if system == "darwin"
        else artifact / "manager.json"
    )
    notice_path = config_path.with_name(NOTICE.name)
    missing = [
        str(path) for path in (artifact, executable, config_path, notice_path) if not path.exists()
    ]
    if missing:
        raise BuildConfigurationError("PyInstaller output is incomplete: " + ", ".join(missing))


def remove_failed_output(output_directory: Path) -> None:
    """Remove the newly-created PyInstaller destination after a failed invocation."""

    if not output_directory.exists():
        return
    if output_directory.is_symlink() or not output_directory.is_dir():
        raise BuildConfigurationError(
            f"Failed PyInstaller output is not a removable directory: {output_directory}"
        )
    shutil.rmtree(output_directory)


def build_manager(
    *,
    origin: str,
    version: str,
    output_directory: Path,
    run: CommandRunner | None = None,
) -> int:
    """Build and validate one unsigned host-native artifact without launching it."""

    sys.path.insert(0, str(MANAGER_ROOT))
    from openslate_manager.config import parse_public_config

    canonical_output_directory = resolve_output_directory(output_directory)
    system, _machine = validate_host_platform()
    manager_config = parse_public_config({"origin": origin, "version": version})
    if canonical_output_directory.exists():
        raise BuildConfigurationError(
            f"Output directory must not already exist: {canonical_output_directory}"
        )
    canonical_output_directory.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="openslate-manager-") as temporary:
        temporary_directory = Path(temporary)
        command = build_command(
            source_root=ROOT,
            output_directory=canonical_output_directory,
            work_directory=temporary_directory / "work",
            spec_directory=temporary_directory / "spec",
        )
        command_runner = run or subprocess.run
        try:
            result = command_runner(command, cwd=ROOT, check=False)
        except OSError as error:
            remove_failed_output(canonical_output_directory)
            print(f"PyInstaller could not run: {error}", file=sys.stderr)
            return 127
        if result.returncode != 0:
            remove_failed_output(canonical_output_directory)
            return int(result.returncode)
        try:
            artifact = artifact_path(canonical_output_directory, system)
            install_public_files(artifact, system, manager_config)
            if system == "darwin":
                remove_macos_non_bundle_output(canonical_output_directory, artifact)
            verify_artifact(artifact, system)
        except Exception:
            with contextlib.suppress(Exception):
                remove_failed_output(canonical_output_directory)
            raise
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True, help="Canonical HTTPS OpenSlate origin")
    parser.add_argument("--version", required=True, help="Public OpenSlate Manager release version")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "dist/native-manager",
        help="New output directory for one unsigned host-native artifact",
    )
    args = parser.parse_args(argv)
    try:
        return build_manager(
            origin=args.origin, version=args.version, output_directory=args.output_dir
        )
    except BuildConfigurationError as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
