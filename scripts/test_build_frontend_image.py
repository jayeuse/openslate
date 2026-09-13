"""Focused tests for the frontend image build helper."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

import build_frontend_image


class FrontendImageBuildTests(unittest.TestCase):
    def test_build_command_reads_only_public_values_without_shell_evaluation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_file = root / "frontend/.env.local"
            env_file.parent.mkdir()
            env_file.write_text(
                'NEXT_PUBLIC_SUPABASE_URL="https://supabase.invalid"\n'
                'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="public-key-$HOME"\n'
                'NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED="false"\n'
            )

            command = build_frontend_image.build_command(root, env_file, "test:frontend")

            self.assertEqual(command[0:2], ["docker", "build"])
            self.assertIn(
                "NEXT_PUBLIC_SUPABASE_URL=https://supabase.invalid",
                command,
            )
            self.assertIn(
                "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=public-key-$HOME",
                command,
            )
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
                        'NEXT_PUBLIC_SUPABASE_URL="https://supabase.invalid"\n'
                        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="public-key"\n'
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

    def test_runtime_export_uses_only_the_container_it_created_and_always_cleans_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "frontend/runtime.tgz"
            calls: list[list[str]] = []

            def run(command, **_kwargs):
                calls.append(command)
                if command[:2] == ["docker", "create"]:
                    return subprocess.CompletedProcess(command, 0, stdout="container-id\n")
                if command[:2] == ["docker", "cp"]:
                    return subprocess.CompletedProcess(command, 0)
                if command[0] == "node":
                    return subprocess.CompletedProcess(command, 17)
                return subprocess.CompletedProcess(command, 0)

            self.assertEqual(
                build_frontend_image.export_runtime(
                    root, "test:frontend", destination, run=run
                ),
                17,
            )
            self.assertIn(["docker", "rm", "-f", "container-id"], calls)
            create = next(command for command in calls if command[:2] == ["docker", "create"])
            self.assertEqual(create, ["docker", "create", "test:frontend"])
            copy = next(command for command in calls if command[:2] == ["docker", "cp"])
            self.assertEqual(copy[2], "container-id:/app/.")

    def test_successful_build_can_export_one_normalized_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_file = root / "frontend/.env.local"
            env_file.parent.mkdir()
            env_file.write_text(
                'NEXT_PUBLIC_SUPABASE_URL="https://supabase.invalid"\n'
                'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="public-key"\n'
                'NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED="false"\n'
            )
            calls: list[list[str]] = []

            def run(command, **_kwargs):
                calls.append(command)
                if command[:2] == ["docker", "create"]:
                    return subprocess.CompletedProcess(command, 0, stdout="container-id\n")
                return subprocess.CompletedProcess(command, 0)

            self.assertEqual(
                build_frontend_image.build_image(
                    root,
                    env_file,
                    "test:frontend",
                    runtime_output=root / "frontend/runtime.tgz",
                    run=run,
                ),
                0,
            )
            self.assertEqual(sum(command[:2] == ["docker", "build"] for command in calls), 1)
            self.assertEqual(sum(command[:2] == ["docker", "create"] for command in calls), 1)


if __name__ == "__main__":
    unittest.main()
