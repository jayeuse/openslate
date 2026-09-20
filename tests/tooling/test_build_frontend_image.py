"""Focused tests for the frontend image build helper."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts import build_frontend_image


class FrontendImageBuildTests(unittest.TestCase):
    def test_build_command_reads_only_public_values_without_shell_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_file = root / "frontend/.env.local"
            env_file.parent.mkdir()
            env_file.write_text(
                'NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED="false-$HOME"\n'
            )

            command = build_frontend_image.build_command(root, env_file, "test:frontend")

            self.assertEqual(command[0:2], ["docker", "build"])
            self.assertEqual(command.count("--build-arg"), 1)
            self.assertIn("NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED=false-$HOME", command)
            self.assertNotIn("sh", command)
            self.assertNotIn("source", command)

    def test_missing_projection_is_generated_before_docker_and_docker_code_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_file = root / "frontend/.env.local"
            calls: list[list[str]] = []

            def run(command, **_kwargs):
                calls.append(command)
                if command[0] == "uv":
                    env_file.parent.mkdir()
                    env_file.write_text(
                        'NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED="false"\n'
                    )
                    return subprocess.CompletedProcess(command, 0)
                return subprocess.CompletedProcess(command, 19)

            self.assertEqual(
                build_frontend_image.build_image(root, env_file, "test:frontend", run=run),
                19,
            )
            self.assertEqual(calls[0][0:2], ["uv", "run"])
            self.assertEqual(calls[1][0:2], ["docker", "build"])

if __name__ == "__main__":
    unittest.main()
