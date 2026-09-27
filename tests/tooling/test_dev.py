"""Short developer commands hide Compose configuration plumbing."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]
DEV_PATH = ROOT / "scripts" / "dev.py"
spec = importlib.util.spec_from_file_location("openslate_dev", DEV_PATH)
assert spec is not None and spec.loader is not None
dev = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = dev
spec.loader.exec_module(dev)


class DeveloperCommandTests(unittest.TestCase):
    def test_direct_cli_imports_its_environment_helper(self) -> None:
        result = subprocess.run(
            [sys.executable, str(DEV_PATH), "--help"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("frontend", result.stdout)
        self.assertIn("caddy", result.stdout)

    def test_named_commands_expand_to_the_supported_compose_actions(self) -> None:
        expected = {
            "db": ["up", "-d"],
            "studio": ["up", "-d", "api-gw"],
            "caddy": ["--profile", "gateway", "up", "-d", "--force-recreate", "caddy"],
            "containers": ["up", "-d"],
            "status": ["ps"],
            "stop": ["stop"],
        }

        for name, compose_arguments in expected.items():
            with self.subTest(name=name):
                command = dev.build_command(name)
                self.assertEqual(
                    command[-(len(compose_arguments) + 1) :],
                    ["compose", *compose_arguments],
                )
                self.assertEqual(command[:4], ["uv", "run", "--directory", str(ROOT / "backend")])

    def test_main_runs_from_the_repository_root_and_returns_the_child_status(self) -> None:
        runner = Mock(return_value=subprocess.CompletedProcess([], 7))

        result = dev.main(["studio"], runner=runner)

        self.assertEqual(result, 7)
        self.assertEqual(runner.call_args.kwargs["cwd"], ROOT)
        self.assertFalse(runner.call_args.kwargs["check"])
        self.assertEqual(runner.call_args.args[0], dev.build_command("studio"))

    def test_stop_can_target_one_named_container(self) -> None:
        self.assertEqual(
            dev.build_command("stop", "studio")[-2:],
            ["stop", "studio"],
        )

    def test_caddy_is_an_explicit_opt_in_action(self) -> None:
        self.assertEqual(
            dev.build_command("caddy")[-6:],
            ["--profile", "gateway", "up", "-d", "--force-recreate", "caddy"],
        )
        self.assertEqual(
            dev.build_command("stop", "caddy")[-4:],
            ["--profile", "gateway", "stop", "caddy"],
        )

    def test_separate_installation_file_is_forwarded_to_environment_wrapper(self) -> None:
        selected = ROOT / ".agent-runtime/new-install.env"
        command = dev.build_command("db", env_file=selected)
        self.assertEqual(command[-5:], ["--env-file", str(selected), "compose", "up", "-d"])

    def test_relative_installation_file_uses_callers_directory(self) -> None:
        runner = Mock(return_value=subprocess.CompletedProcess([], 0))
        original_directory = Path.cwd()
        with tempfile.TemporaryDirectory() as temporary:
            try:
                os.chdir(temporary)
                selected = Path.cwd() / "private" / "install.env"
                result = dev.main(["--env-file", "private/install.env", "db"], runner=runner)
            finally:
                os.chdir(original_directory)

            self.assertEqual(result, 0)
            self.assertEqual(
                runner.call_args.args[0][-5:],
                ["--env-file", str(selected), "compose", "up", "-d"],
            )
            self.assertEqual(runner.call_args.kwargs["cwd"], ROOT)


if __name__ == "__main__":
    unittest.main()
