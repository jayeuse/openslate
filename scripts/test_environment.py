"""Configuration projection protects secrets and keeps each editable value unique."""

import importlib.util
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

spec = importlib.util.spec_from_file_location(
    "project_environment", Path(__file__).with_name("environment.py")
)
assert spec is not None and spec.loader is not None
environment = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = environment
spec.loader.exec_module(environment)


def fixture():
    values = environment.read_environment(environment.ROOT / ".env.example")
    values.update(
        {
            "SUPABASE_PUBLISHABLE_KEY": "test-public-key",
            "SUPABASE_SECRET_KEY": "private-service-canary",
            "SECURITY_EVENT_SERVER_KEY": "private-security-canary",
            "DATABASE_URL": "postgresql+psycopg://openslate_runtime:encoded%40private@127.0.0.1:54322/postgres",
            "MIGRATION_DATABASE_URL": "postgresql+psycopg://postgres:owner-private@127.0.0.1:54322/postgres",
            "ADMIN_EMAIL": "admin@example.test",
            "ADMIN_USERNAME": "local-admin",
            "ADMIN_PASSWORD": "private-admin-canary",
        }
    )
    return values


class EnvironmentProjectionTests(unittest.TestCase):
    def test_frontend_receives_exact_allowlist_and_no_private_values(self):
        values = fixture()
        result = environment.frontend_environment(values)
        self.assertEqual(
            set(result),
            {
                "BACKEND_URL",
                "SUPABASE_SERVER_URL",
                "LOG_DIR",
                "PORT",
                "HOSTNAME",
                "BFF_REQUEST_BODY_LIMIT_BYTES",
                "BFF_RESPONSE_BODY_LIMIT_BYTES",
                "BFF_REQUEST_DEADLINE_MS",
                "NEXT_PUBLIC_SUPABASE_URL",
                "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
                "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED",
            },
        )
        for name in (
            "ADMIN_PASSWORD",
            "DATABASE_URL",
            "MIGRATION_DATABASE_URL",
            "SUPABASE_SECRET_KEY",
        ):
            self.assertNotIn(name, result)
            self.assertNotIn(values[name], result.values())
        self.assertEqual(result["PORT"], values["FRONTEND_PORT"])
        self.assertEqual(
            result["NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED"], values["LIFECYCLE_PURGE_ENABLED"]
        )

    def test_frontend_missing_and_invalid_values_name_the_key_without_leaking_values(self):
        for name, value in [
            ("BACKEND_URL", ""),
            ("SUPABASE_URL", "invalid-private-url"),
            ("BFF_REQUEST_DEADLINE_MS", "12trailing-private"),
            ("LIFECYCLE_PURGE_ENABLED", "not-boolean-private"),
            ("FRONTEND_PORT", "70000"),
            ("FRONTEND_LOG_DIR", "relative-private"),
        ]:
            with self.subTest(name=name):
                values = {**fixture(), name: value}
                with self.assertRaises(environment.ConfigurationError) as raised:
                    environment.frontend_environment(values)
                self.assertIn(name, str(raised.exception))
                if value:
                    self.assertNotIn(value, str(raised.exception))

    def test_container_transport_changes_without_copying_admin_or_owner_credentials(self):
        values = fixture()
        result = environment.compose_environment(values)
        self.assertEqual(urlsplit(result["DATABASE_URL"]).hostname, "host.docker.internal")
        self.assertEqual(urlsplit(result["DATABASE_URL"]).password, "encoded%40private")
        self.assertEqual(result["SUPABASE_JWT_ISSUER"], values["SUPABASE_JWT_ISSUER"])
        self.assertEqual(result["NEXT_PUBLIC_SUPABASE_URL"], values["SUPABASE_URL"])
        self.assertEqual(result["BACKEND_URL"], "http://backend:8000")
        self.assertEqual(result["OPENSLATE_ENV_SOURCE"], "process")
        self.assertNotIn("ADMIN_PASSWORD", result)
        self.assertNotIn("MIGRATION_DATABASE_URL", result)

    def test_owner_and_admin_values_are_not_required_to_project_runtime(self):
        values = fixture()
        for name in ("ADMIN_EMAIL", "ADMIN_USERNAME", "ADMIN_PASSWORD", "MIGRATION_DATABASE_URL"):
            values.pop(name)
        environment.validate(values, operations=False)
        environment.compose_environment(values)
        with self.assertRaises(environment.ConfigurationError):
            environment.validate(values)

    def test_retired_alias_does_not_hide_a_bad_source(self):
        values = {**fixture(), "COMPOSE_DATABASE_URL": "private-old-credential"}
        with self.assertRaises(environment.ConfigurationError) as raised:
            environment.validate(values)
        self.assertIn("COMPOSE_DATABASE_URL", str(raised.exception))
        self.assertNotIn("private-old-credential", str(raised.exception))

    def test_endpoint_and_port_disagreement_is_an_error(self):
        values = {**fixture(), "FRONTEND_PORT": "4011"}
        with self.assertRaises(environment.ConfigurationError) as raised:
            environment.validate(values)
        self.assertIn("FRONTEND_PORT", str(raised.exception))

    def test_projection_replaces_stale_file_privately_and_preserves_exact_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env.local"
            path.write_text("BACKEND_URL=old\n")
            path.chmod(0o644)
            expected = environment.frontend_environment(fixture())
            environment.write_environment(path, expected)
            self.assertEqual(environment.read_environment(path), expected)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertFalse(path.with_name(path.name + ".tmp").exists())

    def test_failed_projection_leaves_existing_file_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "frontend").mkdir()
            previous = root / "frontend/.env.local"
            previous.write_text("previous-file\n")
            environment.write_environment(root / ".env", {**fixture(), "BACKEND_URL": ""})
            output = io.StringIO()
            with patch.object(environment, "ROOT", root), redirect_stderr(output):
                self.assertEqual(environment.main(["frontend"]), 2)
            self.assertEqual(previous.read_text(), "previous-file\n")
            self.assertIn("BACKEND_URL", output.getvalue())
            self.assertNotIn("private-admin-canary", output.getvalue())

    def test_compose_uses_projected_values_instead_of_stale_shell_or_root_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment.write_environment(root / ".env", fixture())
            with (
                patch.object(environment, "ROOT", root),
                patch.dict(
                    os.environ, {"DATABASE_URL": "stale", "ADMIN_PASSWORD": "stale-private"}
                ),
                patch.object(environment.subprocess, "run") as run,
                redirect_stdout(io.StringIO()),
            ):
                run.return_value.returncode = 0
                self.assertEqual(environment.main(["compose", "config", "--quiet"]), 0)
                child = run.call_args.kwargs["env"]
                self.assertEqual(urlsplit(child["DATABASE_URL"]).hostname, "host.docker.internal")
                self.assertNotIn("ADMIN_PASSWORD", child)
                self.assertNotIn("MIGRATION_DATABASE_URL", child)
                self.assertEqual(run.call_args.args[0][3], os.devnull)


if __name__ == "__main__":
    unittest.main()
