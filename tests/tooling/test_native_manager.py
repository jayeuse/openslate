"""Focused contracts for the Gate 0 native OpenSlate Manager build."""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from scripts import build_native_manager

ROOT = Path(__file__).resolve().parents[2]
MANAGER_ROOT = ROOT / "packaging/manager"
sys.path.insert(0, str(MANAGER_ROOT))

from openslate_manager import app, config, ui  # noqa: E402


class ManagerConfigTests(unittest.TestCase):
    def test_accepts_only_canonical_https_origins_and_public_version(self):
        manager_config = config.parse_public_config(
            {"origin": "https://openslate.example:8443", "version": "0.1.0"}
        )

        self.assertEqual(manager_config.origin, "https://openslate.example:8443")
        self.assertEqual(manager_config.version, "0.1.0")

        for origin in (
            "http://openslate.example",
            "https://openslate.example/path",
            "https://user@openslate.example",
            "https://openslate.example/?query=1",
            "https://openslate.example/#fragment",
            "https://openslate.example\x00",
        ):
            with self.subTest(origin=origin):
                with self.assertRaises(config.ManagerConfigError):
                    config.parse_public_config({"origin": origin, "version": "0.1.0"})

    def test_rejects_secrets_and_unknown_config_fields(self):
        with self.assertRaises(config.ManagerConfigError):
            config.parse_public_config(
                {
                    "origin": "https://openslate.example",
                    "version": "0.1.0",
                    "token": "must-not-be-accepted",
                }
            )


class ManagerUiBoundaryTests(unittest.TestCase):
    def test_window_has_no_javascript_bridge_or_service_controls(self):
        calls: list[tuple[str, tuple[object, ...], dict[str, object]]] = []

        class FakeWebview:
            def create_window(self, *args: object, **kwargs: object) -> object:
                calls.append(("create_window", args, kwargs))
                return object()

            def start(self) -> None:
                calls.append(("start", (), {}))

        with patch.dict(sys.modules, {"webview": FakeWebview()}):
            ui.open_manager_window(config.ManagerConfig("https://openslate.example", "0.1.0"))

        self.assertEqual(
            calls,
            [
                ("create_window", ("OpenSlate Manager", "https://openslate.example"), {}),
                ("start", (), {}),
            ],
        )
        self.assertNotIn("subprocess", (MANAGER_ROOT / "openslate_manager/ui.py").read_text())

    def test_cli_has_no_certificate_bypass_or_supervision_options(self):
        parser = app.build_parser()

        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parser.parse_args(["--ignore-certificate-errors"])
            with self.assertRaises(SystemExit):
                parser.parse_args(["--start-services"])


class ManagerBuildTests(unittest.TestCase):
    def test_build_command_is_host_native_onedir(self):
        with tempfile.TemporaryDirectory() as directory:
            output_directory = Path(directory) / "dist"
            command = build_native_manager.build_command(
                source_root=ROOT,
                output_directory=output_directory,
                work_directory=Path(directory) / "work",
                spec_directory=Path(directory) / "spec",
            )

        self.assertIn("--onedir", command)
        self.assertIn("--windowed", command)
        self.assertNotIn("--target-architecture", command)
        self.assertIn(str(MANAGER_ROOT), command)

    def test_installation_includes_public_config_and_third_party_notice(self):
        with tempfile.TemporaryDirectory() as directory:
            artifact = Path(directory) / "OpenSlate Manager"
            artifact.mkdir()

            build_native_manager.install_public_files(
                artifact,
                "win32",
                config.ManagerConfig("https://openslate.example", "0.1.0"),
            )

            self.assertTrue((artifact / "manager.json").is_file())
            self.assertTrue((artifact / "THIRD_PARTY_NOTICES.md").is_file())

    def test_installation_refuses_a_missing_pyinstaller_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(build_native_manager.BuildConfigurationError):
                build_native_manager.install_public_files(
                    Path(directory) / "missing-artifact",
                    "win32",
                    config.ManagerConfig("https://openslate.example", "0.1.0"),
                )

    def test_unsupported_host_is_rejected_before_build(self):
        with patch.object(build_native_manager.sys, "platform", "linux"):
            with self.assertRaises(build_native_manager.BuildConfigurationError):
                build_native_manager.validate_host_platform()

    def test_build_writes_only_public_manager_config_and_preserves_runner_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            output_directory = Path(directory) / "dist"
            captured: list[list[str]] = []

            def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[object]:
                captured.append(command)
                return subprocess.CompletedProcess(command, 27)

            with patch.object(
                build_native_manager,
                "validate_host_platform",
                return_value=("win32", "amd64"),
            ):
                status = build_native_manager.build_manager(
                    origin="https://openslate.example",
                    version="0.1.0",
                    output_directory=output_directory,
                    run=run,
                )

            self.assertEqual(status, 27)
            self.assertEqual(len(captured), 1)
            self.assertFalse((output_directory / "manager.json").exists())

    def test_failed_build_removes_only_the_output_directory_created_by_pyinstaller(self):
        with tempfile.TemporaryDirectory() as directory:
            output_directory = Path(directory) / "dist"

            def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[object]:
                created_output = Path(command[command.index("--distpath") + 1])
                created_output.mkdir()
                (created_output / "partial-artifact").write_text("partial", encoding="utf-8")
                return subprocess.CompletedProcess(command, 27)

            with patch.object(
                build_native_manager,
                "validate_host_platform",
                return_value=("win32", "amd64"),
            ):
                status = build_native_manager.build_manager(
                    origin="https://openslate.example",
                    version="0.1.0",
                    output_directory=output_directory,
                    run=run,
                )

            self.assertEqual(status, 27)
            self.assertFalse(output_directory.exists())

    def test_failed_build_preserves_a_caller_owned_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            output_directory = Path(directory) / "dist"
            output_directory.mkdir()
            owned_file = output_directory / "caller-owned"
            owned_file.write_text("preserve", encoding="utf-8")

            with self.assertRaises(build_native_manager.BuildConfigurationError):
                build_native_manager.build_manager(
                    origin="https://openslate.example",
                    version="0.1.0",
                    output_directory=output_directory,
                    run=lambda *_args, **_kwargs: self.fail("runner must not execute"),
                )

            self.assertEqual(owned_file.read_text(encoding="utf-8"), "preserve")

    def test_install_failure_removes_the_pyinstaller_output_and_preserves_the_error(self):
        with tempfile.TemporaryDirectory() as directory:
            output_directory = Path(directory) / "dist"

            def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[object]:
                Path(command[command.index("--distpath") + 1]).mkdir()
                return subprocess.CompletedProcess(command, 0)

            with (
                patch.object(
                    build_native_manager,
                    "validate_host_platform",
                    return_value=("win32", "amd64"),
                ),
                patch.object(
                    build_native_manager,
                    "install_public_files",
                    side_effect=RuntimeError("install failed"),
                ),
                self.assertRaisesRegex(RuntimeError, "install failed"),
            ):
                build_native_manager.build_manager(
                    origin="https://openslate.example",
                    version="0.1.0",
                    output_directory=output_directory,
                    run=run,
                )

            self.assertFalse(output_directory.exists())

    def test_artifact_verification_failure_removes_the_pyinstaller_output_and_preserves_the_error(
        self,
    ):
        with tempfile.TemporaryDirectory() as directory:
            output_directory = Path(directory) / "dist"

            def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[object]:
                Path(command[command.index("--distpath") + 1]).mkdir()
                return subprocess.CompletedProcess(command, 0)

            with (
                patch.object(
                    build_native_manager,
                    "validate_host_platform",
                    return_value=("win32", "amd64"),
                ),
                patch.object(build_native_manager, "install_public_files"),
                patch.object(
                    build_native_manager,
                    "verify_artifact",
                    side_effect=RuntimeError("verification failed"),
                ),
                self.assertRaisesRegex(RuntimeError, "verification failed"),
            ):
                build_native_manager.build_manager(
                    origin="https://openslate.example",
                    version="0.1.0",
                    output_directory=output_directory,
                    run=run,
                )

            self.assertFalse(output_directory.exists())

    def test_ci_relative_output_is_canonicalized_from_backend_before_pyinstaller_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory) / "repository"
            backend_directory = repository / "backend"
            backend_directory.mkdir(parents=True)
            captured: list[list[str]] = []

            def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[object]:
                captured.append(command)
                return subprocess.CompletedProcess(command, 27)

            previous_directory = Path.cwd()
            try:
                os.chdir(backend_directory)
                with patch.object(
                    build_native_manager,
                    "validate_host_platform",
                    return_value=("win32", "amd64"),
                ):
                    status = build_native_manager.build_manager(
                        origin="https://openslate.example",
                        version="0.1.0",
                        output_directory=Path("../dist/native-manager"),
                        run=run,
                    )
            finally:
                os.chdir(previous_directory)

            expected = (repository / "dist/native-manager").resolve()
            self.assertEqual(status, 27)
            self.assertEqual(captured[0][captured[0].index("--distpath") + 1], str(expected))
            self.assertFalse(expected.exists())

    def test_root_output_directory_is_rejected_before_any_build(self):
        with self.assertRaises(build_native_manager.BuildConfigurationError):
            build_native_manager.resolve_output_directory(Path(Path.cwd().anchor))

    def test_config_writer_never_serializes_extra_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manager.json"
            build_native_manager.write_public_config(
                path,
                config.ManagerConfig("https://openslate.example", "0.1.0"),
            )

            self.assertEqual(
                json.loads(path.read_text(encoding="utf-8")),
                {"origin": "https://openslate.example", "version": "0.1.0"},
            )

    def test_macos_build_retains_only_the_app_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            output_directory = Path(directory) / "dist"
            bundle = output_directory / "OpenSlate Manager.app"
            duplicate = output_directory / "OpenSlate Manager"
            bundle.mkdir(parents=True)
            duplicate.mkdir()
            (duplicate / "stale-onedir-file").write_text("temporary", encoding="utf-8")

            build_native_manager.remove_macos_non_bundle_output(output_directory, bundle)

            self.assertTrue(bundle.exists())
            self.assertFalse(duplicate.exists())

    def test_ci_builds_native_unsigned_development_artifacts(self):
        workflow = (ROOT / ".github/workflows/native-manager.yml").read_text(encoding="utf-8")

        self.assertIn("macos-14", workflow)
        self.assertIn("windows-2025", workflow)
        self.assertIn("uv sync --locked --group manager", workflow)
        self.assertIn("--output-dir ../dist/native-manager", workflow)
        self.assertIn("unsigned development artifact", workflow)
        self.assertIn("ditto -c -k --sequesterRsrc --keepParent", workflow)
        self.assertIn("Compress-Archive -LiteralPath", workflow)
        self.assertIn("path: dist/${{ matrix.artifact }}.zip", workflow)
        self.assertNotIn("path: dist/native-manager", workflow)
        self.assertNotIn("codesign", workflow.lower())
        self.assertNotIn("notar", workflow.lower())


if __name__ == "__main__":
    unittest.main()
