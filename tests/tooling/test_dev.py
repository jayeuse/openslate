"""Short developer commands hide Compose configuration plumbing."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
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
    def test_named_commands_expand_to_the_supported_compose_actions(self) -> None:
        expected = {
            "db": ["up", "-d", "postgres"],
            "pgweb": ["--profile", "db-ui", "up", "-d", "--force-recreate", "pgweb"],
            "caddy": ["--profile", "gateway", "up", "-d", "--force-recreate", "caddy"],
            "containers": [
                "--profile",
                "db-ui",
                "--profile",
                "gateway",
                "up",
                "-d",
                "--force-recreate",
                "pgweb",
                "caddy",
            ],
            "status": ["--profile", "db-ui", "--profile", "gateway", "ps"],
            "stop": ["--profile", "db-ui", "--profile", "gateway", "stop"],
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

        result = dev.main(["pgweb"], runner=runner)

        self.assertEqual(result, 7)
        self.assertEqual(runner.call_args.kwargs["cwd"], ROOT)
        self.assertFalse(runner.call_args.kwargs["check"])
        self.assertEqual(runner.call_args.args[0], dev.build_command("pgweb"))

    def test_stop_can_target_one_named_container(self) -> None:
        self.assertEqual(
            dev.build_command("stop", "pgweb")[-4:],
            ["--profile", "db-ui", "stop", "pgweb"],
        )


if __name__ == "__main__":
    unittest.main()
