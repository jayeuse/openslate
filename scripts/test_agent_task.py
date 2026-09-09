"""Regressions for local and global worker setup validation."""

import argparse
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "agent_task", Path(__file__).with_name("agent-task.py")
)
assert spec is not None and spec.loader is not None
agent_task = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent_task)


class WorkflowCheckTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "project"
        self.codex_home = Path(temporary.name) / "codex-home"
        self.write(
            "AGENTS.md",
            "### Worker routing\n"
            "| Worker | Scope |\n"
            "| --- | --- |\n"
            "| `explore` | inspect |\n"
            "\n"
            "### Skill routing\n"
            "| Skill | Path |\n"
            "| --- | --- |\n"
            "| frontend | `general` |\n",
        )
        self.write(".agents/orchestration/PROTOCOL.md", "Protocol")
        self.write(".agents/orchestration/RUN.md", "Run template")
        self.worker = self.worker_text("explore")

    @staticmethod
    def worker_text(name="explore", **overrides):
        values = {
            "name": name,
            "description": "Inspect the assigned repository question.",
            "model": "existing-model",
            "model_reasoning_effort": "high",
            "developer_instructions": "Inspect the assigned scope.",
        }
        values.update(overrides)
        return (
            f'name = "{values["name"]}"\n'
            f'description = "{values["description"]}"\n'
            f'model = "{values["model"]}"\n'
            "model_reasoning_effort = "
            f'"{values["model_reasoning_effort"]}"\n'
            f'developer_instructions = "{values["developer_instructions"]}"\n'
            "[agents]\n"
            f'enabled = {str(values.get("delegation", False)).lower()}\n'
        )

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def write_global(self, name="explore", content=None):
        path = self.codex_home / "agents" / f"{name}.toml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content or self.worker_text(name))
        return path

    def failures(self, codex_home=None):
        return "\n".join(agent_task.check_workspace(self.root, codex_home))

    def test_valid_setup_with_global_worker_only(self):
        self.write_global()
        self.assertEqual(agent_task.check_workspace(self.root, self.codex_home), [])

    def test_all_routed_global_workers_are_effective(self):
        names = ("utility", "explore", "general", "browser", "implement", "analyst")
        self.write(
            "AGENTS.md",
            "### Worker routing\n"
            "| Worker | Scope |\n"
            "| --- | --- |\n"
            + "".join(f"| `{name}` | assigned |\n" for name in names),
        )
        for name in names:
            self.write_global(name)
        self.assertEqual(agent_task.check_workspace(self.root, self.codex_home), [])

    def test_project_worker_overrides_invalid_global_worker(self):
        self.write(".codex/agents/explore.toml", self.worker)
        self.write_global(content='name = "explore"\ninvalid')
        self.assertEqual(agent_task.check_workspace(self.root, self.codex_home), [])

    def test_malformed_project_override_does_not_fall_back(self):
        self.write(".codex/agents/explore.toml", 'secret = "private-value"\ninvalid')
        self.write_global()
        failures = self.failures(self.codex_home)
        self.assertIn("Cannot parse worker configuration: explore.toml", failures)
        self.assertNotIn("private-value", failures)

    def test_missing_global_routed_worker_fails(self):
        self.assertIn("Missing routed worker: explore", self.failures(self.codex_home))

    def test_malformed_global_worker_fails_without_leaking_contents(self):
        self.write_global(content='secret = "private-value"\ninvalid')
        failures = self.failures(self.codex_home)
        self.assertIn("Cannot parse worker configuration: explore.toml", failures)
        self.assertNotIn("private-value", failures)

    def test_global_worker_read_error_is_sanitized(self):
        global_path = self.write_global()
        original_read_text = Path.read_text

        def read_text(path, *args, **kwargs):
            if path == global_path:
                raise OSError("private-value")
            return original_read_text(path, *args, **kwargs)

        with patch.object(Path, "read_text", new=read_text):
            failures = self.failures(self.codex_home)
        self.assertIn("Cannot read worker configuration: explore.toml", failures)
        self.assertNotIn("private-value", failures)

    def test_project_worker_directory_read_error_is_sanitized(self):
        self.write_global()
        project_directory = self.root / ".codex/agents"
        project_directory.mkdir(parents=True)
        original_iterdir = Path.iterdir

        def iterdir(path):
            if path == project_directory:
                raise OSError("private-value")
            return original_iterdir(path)

        with patch.object(Path, "iterdir", new=iterdir):
            failures = self.failures(self.codex_home)
        self.assertIn("Cannot read project worker configurations", failures)
        self.assertNotIn("private-value", failures)

    def test_default_codex_home_is_used_when_environment_is_unset(self):
        default_home = self.codex_home.parent
        path = default_home / ".codex" / "agents" / "explore.toml"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(self.worker)
        with patch.dict(os.environ, {}, clear=True), patch.object(
            agent_task.Path, "home", return_value=default_home
        ):
            self.assertEqual(agent_task.check_workspace(self.root), [])

    def test_code_home_environment_overrides_default(self):
        self.write_global()
        with patch.dict(os.environ, {"CODEX_HOME": str(self.codex_home)}):
            self.assertEqual(agent_task.check_workspace(self.root), [])

    def test_all_project_worker_definitions_are_validated(self):
        self.write_global()
        self.write(".codex/agents/extra.toml", 'name = "extra"\ninvalid')
        failures = self.failures(self.codex_home)
        self.assertIn("Cannot parse worker configuration: extra.toml", failures)

    def test_required_worker_fields_are_nonempty(self):
        self.write_global(
            content=self.worker_text(
                description="",
                model="",
                model_reasoning_effort="",
                developer_instructions="",
            )
        )
        failures = self.failures(self.codex_home)
        for field in agent_task.WORKER_FIELDS:
            self.assertIn(f"Missing worker {field}: explore.toml", failures)

    def test_worker_name_must_match_filename(self):
        self.write_global(content=self.worker_text("other"))
        self.assertIn(
            "Worker name does not match filename: explore.toml",
            self.failures(self.codex_home),
        )

    def test_delegation_must_be_exactly_disabled(self):
        self.write_global(content=self.worker_text(delegation=True))
        self.assertIn(
            "Worker must disable delegation: explore.toml",
            self.failures(self.codex_home),
        )

    def test_missing_delegation_setting_fails(self):
        self.write_global(content=self.worker_text().split("[agents]")[0])
        self.assertIn(
            "Worker must disable delegation: explore.toml",
            self.failures(self.codex_home),
        )

    def test_missing_local_setup_fails(self):
        self.write_global()
        (self.root / ".agents/orchestration/PROTOCOL.md").unlink()
        self.assertIn("Missing or empty workflow asset", self.failures(self.codex_home))

    def test_empty_asset_fails(self):
        self.write_global()
        self.write(".agents/orchestration/RUN.md", " ")
        self.assertIn("Missing or empty workflow asset", self.failures(self.codex_home))

    def test_missing_guide_and_workers_fails(self):
        (self.root / "AGENTS.md").unlink()
        self.assertIn("Missing or empty workflow asset: AGENTS.md", self.failures())

    def test_empty_routing_fails_without_requiring_local_workers(self):
        self.write("AGENTS.md", "No routing")
        failures = self.failures(self.codex_home)
        self.assertIn("No worker roles", failures)
        self.assertNotIn("No local worker configurations found", failures)

    def test_skill_tables_do_not_create_worker_requirements(self):
        self.write_global()
        failures = self.failures(self.codex_home)
        self.assertNotIn("Missing routed worker: general", failures)

    def test_existing_commands_and_doctor_remain_available(self):
        parser = agent_task.build_parser()
        for command in ("init", "status", "validate"):
            self.assertEqual(parser.parse_args([command, "example"]).command, command)
        self.assertIs(parser.parse_args(["doctor"]).func, agent_task.cmd_doctor)

    def test_doctor_failure_exits_nonzero(self):
        with patch.object(
            agent_task, "check_workspace", return_value=["Missing worker"]
        ), patch("builtins.print"), self.assertRaises(SystemExit) as result:
            agent_task.cmd_doctor(argparse.Namespace())
        self.assertEqual(result.exception.code, 1)

    def test_doctor_read_error_is_sanitized(self):
        with patch.object(
            agent_task, "check_workspace", side_effect=OSError("secret")
        ), patch("builtins.print") as output, self.assertRaises(SystemExit):
            agent_task.cmd_doctor(argparse.Namespace())
        self.assertNotIn("secret", str(output.call_args_list))


if __name__ == "__main__":
    unittest.main()
