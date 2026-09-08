"""Regressions for setup failures that must never be reported as a PASS."""

import argparse
import importlib.util
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
        self.root = Path(temporary.name)
        self.write("AGENTS.md", "| Work | `explore` |\n")
        self.write(".agents/orchestration/PROTOCOL.md", "Protocol")
        self.write(".agents/orchestration/RUN.md", "Run template")
        self.worker = (
            'name = "explore"\nmodel = "existing-model"\n'
            'model_reasoning_effort = "high"\ndeveloper_instructions = "Inspect"\n'
            '[agents]\nenabled = false\n'
        )
        self.write(".codex/agents/explore.toml", self.worker)

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def failures(self):
        return "\n".join(agent_task.check_workspace(self.root))

    def test_valid_setup(self):
        self.assertEqual(agent_task.check_workspace(self.root), [])

    def test_missing_local_setup_fails(self):
        (self.root / ".agents/orchestration/PROTOCOL.md").unlink()
        self.assertIn("Missing or empty workflow asset", self.failures())

    def test_empty_asset_fails(self):
        self.write(".agents/orchestration/RUN.md", " ")
        self.assertIn("Missing or empty workflow asset", self.failures())

    def test_missing_routed_worker_fails(self):
        self.write("AGENTS.md", "| Work | `backend-test`, `frontend-test` |\n")
        failures = self.failures()
        self.assertIn("Missing routed worker: backend-test", failures)
        self.assertIn("Missing routed worker: frontend-test", failures)

    def test_invalid_config_does_not_leak_contents(self):
        self.write(".codex/agents/explore.toml", 'secret = "private-value"\ninvalid')
        failures = self.failures()
        self.assertIn("Cannot parse worker configuration", failures)
        self.assertNotIn("private-value", failures)

    def test_delegation_must_be_explicitly_disabled(self):
        for value in ('true', '"false"'):
            with self.subTest(value=value):
                self.write(".codex/agents/explore.toml", self.worker.replace("false", value))
                self.assertIn("Worker must disable delegation", self.failures())

    def test_missing_delegation_setting_fails(self):
        self.write(".codex/agents/explore.toml", self.worker.split("[agents]")[0])
        self.assertIn("Worker must disable delegation", self.failures())

    def test_wrong_name_or_empty_instructions_fails(self):
        self.write(
            ".codex/agents/explore.toml",
            self.worker.replace('"explore"', '"wrong"').replace('"Inspect"', '""'),
        )
        failures = self.failures()
        self.assertIn("Worker name does not match filename", failures)
        self.assertIn("Missing worker developer_instructions", failures)

    def test_missing_guide_and_workers_fails(self):
        (self.root / "AGENTS.md").unlink()
        self.assertIn("Missing or empty workflow asset: AGENTS.md", self.failures())

    def test_empty_routing_and_worker_directory_fails(self):
        self.write("AGENTS.md", "No routing")
        (self.root / ".codex/agents/explore.toml").unlink()
        failures = self.failures()
        self.assertIn("No worker roles", failures)
        self.assertIn("No local worker configurations", failures)

    def test_existing_commands_and_doctor_remain_available(self):
        parser = agent_task.build_parser()
        for command in ("init", "status", "validate"):
            self.assertEqual(parser.parse_args([command, "example"]).command, command)
        self.assertIs(parser.parse_args(["doctor"]).func, agent_task.cmd_doctor)

    def test_doctor_failure_exits_nonzero(self):
        with patch.object(agent_task, "check_workspace", return_value=["Missing worker"]):
            with patch("builtins.print"), self.assertRaises(SystemExit) as result:
                agent_task.cmd_doctor(argparse.Namespace())
        self.assertEqual(result.exception.code, 1)

    def test_doctor_read_error_is_sanitized(self):
        with patch.object(agent_task, "check_workspace", side_effect=OSError("secret")):
            with patch("builtins.print") as output, self.assertRaises(SystemExit):
                agent_task.cmd_doctor(argparse.Namespace())
        self.assertNotIn("secret", str(output.call_args_list))


if __name__ == "__main__":
    unittest.main()
