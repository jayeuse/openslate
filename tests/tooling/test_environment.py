"""Configuration projection keeps database and application secrets out of the frontend."""

import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "project_environment", Path(__file__).resolve().parents[2] / "scripts" / "environment.py"
)
assert spec is not None and spec.loader is not None
environment = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = environment
spec.loader.exec_module(environment)


def fixture() -> dict[str, str]:
    values = environment.read_environment(environment.ROOT / ".env.example")
    values.update(
        {
            "POSTGRES_BOOTSTRAP_PASSWORD": "bootstrap-canary",
            "DATABASE_BOOTSTRAP_URL": "postgresql+psycopg://postgres:bootstrap-canary@127.0.0.1:54322/openslate",
            "MIGRATION_DATABASE_URL": "postgresql+psycopg://openslate_owner:owner-canary@127.0.0.1:54322/openslate",
            "DATABASE_URL": "postgresql+psycopg://openslate_runtime:runtime-canary@127.0.0.1:54322/openslate",
            "DATABASE_INSPECTOR_URL": "postgresql+psycopg://openslate_inspector:inspector-canary@127.0.0.1:54322/openslate",
            "PGWEB_BIND_HOST": "127.0.0.1",
            "PGWEB_PORT": "8081",
            "GATEWAY_PUBLIC_HOST": "localhost",
            "GATEWAY_BIND_HOST": "127.0.0.1",
            "GATEWAY_PORT": "3448",
            "AUTH_JWT_SECRET": "a" * 64,
            "SECURITY_EVENT_SERVER_KEY": "security-canary",
            "ADMIN_EMAIL": "admin@example.test",
            "ADMIN_USERNAME": "local-admin",
            "ADMIN_PASSWORD": "admin-canary",
        }
    )
    return values


class EnvironmentProjectionTests(unittest.TestCase):
    def test_compose_denylist_covers_every_defined_root_environment_key(self) -> None:
        names = set(environment.read_environment(environment.ROOT / ".env.example"))

        self.assertFalse(names - environment.ROOT_ENVIRONMENT_KEYS)

    def test_frontend_receives_only_its_safe_runtime_values(self) -> None:
        values = fixture()
        result = environment.frontend_environment(values)
        self.assertEqual(
            set(result),
            {
                "BACKEND_URL",
                "LOG_DIR",
                "PORT",
                "HOSTNAME",
                "NEXT_PUBLIC_LIFECYCLE_PURGE_ENABLED",
            },
        )
        for name in (
            "DATABASE_URL",
            "MIGRATION_DATABASE_URL",
            "DATABASE_BOOTSTRAP_URL",
            "DATABASE_INSPECTOR_URL",
            "AUTH_JWT_SECRET",
        ):
            self.assertNotIn(name, result)
            self.assertNotIn(values[name], result.values())

    def test_development_cors_allows_gateway_and_direct_frontend_origins(self) -> None:
        values = fixture()

        self.assertEqual(
            json.loads(values["CORS_ORIGINS"]),
            [values["PUBLIC_ORIGIN"], values["FRONTEND_URL"]],
        )

    def test_database_urls_require_distinct_expected_roles(self) -> None:
        values = fixture()
        environment.validate(values)
        for name, value in (
            ("DATABASE_URL", values["MIGRATION_DATABASE_URL"]),
            ("MIGRATION_DATABASE_URL", values["DATABASE_URL"]),
            ("DATABASE_BOOTSTRAP_URL", values["DATABASE_URL"]),
            ("DATABASE_BOOTSTRAP_URL", values["DATABASE_INSPECTOR_URL"]),
            ("DATABASE_INSPECTOR_URL", values["DATABASE_URL"]),
        ):
            with self.subTest(name=name):
                invalid = {**values, name: value}
                with self.assertRaises(environment.ConfigurationError):
                    environment.validate(invalid)

    def test_compose_uses_only_postgres_and_runtime_values(self) -> None:
        result = environment.compose_environment(fixture(), services={"postgres"})
        self.assertEqual(
            result,
            {
                "POSTGRES_DATABASE": "openslate",
                "POSTGRES_BOOTSTRAP_PASSWORD": "bootstrap-canary",
                "POSTGRES_PORT": "54322",
            },
        )

    def test_database_start_projects_only_fresh_database_settings(self) -> None:
        values = environment.read_environment(environment.ROOT / ".env.example")

        result = environment.compose_environment(values, services={"postgres"})

        self.assertEqual(
            result,
            {
                "POSTGRES_DATABASE": "openslate",
                "POSTGRES_BOOTSTRAP_PASSWORD": "openslate-local-development",
                "POSTGRES_PORT": "54322",
            },
        )

    def test_database_start_does_not_generate_optional_service_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = environment.read_environment(environment.ROOT / ".env.example")
            environment.write_environment(root / ".env", values)
            with (
                patch.object(environment, "ROOT", root),
                patch.object(environment, "write_pgweb_passfile") as write_pgweb_passfile,
                patch.object(environment, "write_caddy_config") as write_caddy_config,
                patch.object(environment.subprocess, "run") as run,
            ):
                run.return_value.returncode = 0

                self.assertEqual(environment.main(["compose", "up", "-d", "postgres"]), 0)

            write_pgweb_passfile.assert_not_called()
            write_caddy_config.assert_not_called()
            child = run.call_args.kwargs["env"]
            self.assertEqual(child["POSTGRES_DATABASE"], "openslate")
            self.assertNotIn("DATABASE_URL", child)
            self.assertNotIn("PGWEB_PASSFILE_PATH", child)
            self.assertNotIn("CADDY_CONFIG_PATH", child)

    def test_pgweb_listener_must_remain_on_ipv4_loopback(self) -> None:
        values = {**fixture(), "PGWEB_BIND_HOST": "0.0.0.0"}

        with self.assertRaises(environment.ConfigurationError) as raised:
            environment.validate(values)

        self.assertIn("PGWEB_BIND_HOST", str(raised.exception))

    def test_pgweb_passfile_escapes_database_and_password_fields(self) -> None:
        values = fixture()
        values["POSTGRES_DATABASE"] = r"open:slate\local"
        values["DATABASE_INSPECTOR_URL"] = (
            values["DATABASE_INSPECTOR_URL"].rsplit("/", maxsplit=1)[0]
            + r"/open:slate\local"
        )
        values["DATABASE_INSPECTOR_URL"] = values["DATABASE_INSPECTOR_URL"].replace(
            "inspector-canary@", "inspect%3Aor%5Clocal@"
        )

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(environment, "ROOT", Path(directory)):
                passfile = environment.write_pgweb_passfile(values)

            self.assertEqual(
                passfile.read_text(),
                "postgres:5432:open\\:slate\\\\local:openslate_inspector:"
                "inspect\\:or\\\\local\n",
            )

    def test_postgres_is_hard_bound_to_loopback_in_compose(self) -> None:
        compose = (environment.ROOT / "compose.yaml").read_text(encoding="utf-8")

        self.assertIn('"127.0.0.1:${POSTGRES_PORT:-54322}:5432"', compose)
        self.assertNotIn("COMPOSE_BIND_HOST", compose)

    def test_database_urls_must_use_the_configured_postgres_endpoint(self) -> None:
        values = fixture()
        values["DATABASE_URL"] = values["DATABASE_URL"].replace(
            "127.0.0.1", "db.example.test"
        )

        with self.assertRaises(environment.ConfigurationError) as raised:
            environment.validate(values)

        self.assertIn("DATABASE_URL", str(raised.exception))

    def test_postgres_host_must_remain_on_ipv4_loopback(self) -> None:
        values = fixture()
        for name in (
            "DATABASE_BOOTSTRAP_URL",
            "MIGRATION_DATABASE_URL",
            "DATABASE_URL",
            "DATABASE_INSPECTOR_URL",
        ):
            values[name] = values[name].replace("127.0.0.1", "localhost")
        values["POSTGRES_HOST"] = "localhost"

        with self.assertRaises(environment.ConfigurationError) as raised:
            environment.validate(values)

        self.assertEqual(str(raised.exception), "POSTGRES_HOST must remain on IPv4 loopback")

    def test_enabled_smtp_is_checked_without_projecting_mail_credentials_to_compose(self) -> None:
        values = {
            **fixture(),
            "SMTP_ENABLED": "true",
            "SMTP_HOST": "smtp.example.test",
            "SMTP_PORT": "587",
            "SMTP_USERNAME": "mailer",
            "SMTP_PASSWORD": "smtp-canary",
            "SMTP_FROM": "noreply@example.test",
            "SMTP_TRANSPORT": "starttls",
            "SMTP_DELIVERY_ENCRYPTION_KEY": "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        }

        environment.validate(values)

        compose = environment.compose_environment(values, services={"postgres"})
        self.assertNotIn("SMTP_PASSWORD", compose)
        self.assertNotIn("SMTP_DELIVERY_ENCRYPTION_KEY", compose)

    def test_caddy_uses_distinct_external_and_container_ports(self) -> None:
        values = {
            **fixture(),
            "GATEWAY_PORT": "4443",
            "PUBLIC_ORIGIN": "https://localhost:4443",
            "AUTH_JWT_ISSUER": "https://localhost:4443",
        }

        result = environment.compose_environment(values, services={"caddy"})

        self.assertEqual(result["GATEWAY_PORT"], "4443")
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(environment, "ROOT", Path(directory)):
                caddy = environment.write_caddy_config(values).read_text(encoding="utf-8")
        self.assertIn("https://localhost:3448", caddy)
        compose = (environment.ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn('"${GATEWAY_BIND_HOST:-127.0.0.1}:${GATEWAY_PORT:-3448}:3448"', compose)
        self.assertIn("http://127.0.0.1:3449/api/health", compose)

    def test_caddy_healthcheck_uses_an_unpublished_private_listener(self) -> None:
        values = {**fixture(), "GATEWAY_PUBLIC_HOST": "portal.example.test"}

        result = environment.compose_environment(values, services={"caddy"})

        self.assertNotIn("GATEWAY_PUBLIC_HOST", result)
        compose = (environment.ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("http://127.0.0.1:3449/api/health", compose)
        self.assertNotIn("3449:", compose)

    def test_retired_compose_name_is_rejected_without_echoing_values(self) -> None:
        values = {**fixture(), "COMPOSE_DATABASE_URL": "private-canary"}
        with self.assertRaises(environment.ConfigurationError) as raised:
            environment.validate(values)
        self.assertIn("COMPOSE_DATABASE_URL", str(raised.exception))
        self.assertNotIn("private-canary", str(raised.exception))

    def test_caddy_generation_translates_invalid_values_without_echoing_them(self) -> None:
        values = {**fixture(), "GATEWAY_PUBLIC_HOST": "bad\nCaddyfile"}

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(environment, "ROOT", Path(directory)):
                with self.assertRaises(environment.ConfigurationError) as raised:
                    environment.write_caddy_config(values)

        self.assertEqual(str(raised.exception), "Invalid gateway configuration")
        self.assertNotIn("Caddyfile", str(raised.exception))

    def test_failed_frontend_projection_keeps_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "frontend").mkdir()
            previous = root / "frontend/.env.local"
            previous.write_text("previous\n")
            environment.write_environment(root / ".env", {**fixture(), "FRONTEND_PORT": ""})
            output = io.StringIO()
            with patch.object(environment, "ROOT", root), redirect_stderr(output):
                self.assertEqual(environment.main(["frontend"]), 2)
            self.assertEqual(previous.read_text(), "previous\n")
            self.assertIn("FRONTEND_PORT", output.getvalue())

    def test_compose_uses_projected_values_instead_of_stale_shell(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment.write_environment(root / ".env", fixture())
            pgweb_directory = root / ".agent-runtime/pgweb"
            pgweb_directory.mkdir(parents=True)
            pgweb_directory.chmod(0o755)
            with (
                patch.object(environment, "ROOT", root),
                patch.dict(os.environ, {"DATABASE_URL": "stale", "SMTP_PASSWORD": "stale"}),
                patch.object(environment.subprocess, "run") as run,
                redirect_stdout(io.StringIO()),
            ):
                run.return_value.returncode = 0
                self.assertEqual(
                    environment.main(
                        [
                            "compose",
                            "--profile",
                            "db-ui",
                            "--profile",
                            "gateway",
                            "up",
                            "-d",
                            "pgweb",
                            "caddy",
                        ]
                    ),
                    0,
                )
                child = run.call_args.kwargs["env"]
                self.assertNotIn("DATABASE_BOOTSTRAP_URL", child)
                self.assertNotIn("MIGRATION_DATABASE_URL", child)
                self.assertNotIn("DATABASE_INSPECTOR_URL", child)
                self.assertNotIn("DATABASE_URL", child)
                self.assertNotIn("SMTP_PASSWORD", child)
                passfile = Path(child["PGWEB_PASSFILE_PATH"])
                self.assertEqual(passfile.parent.stat().st_mode & 0o777, 0o700)
                self.assertEqual(passfile.stat().st_mode & 0o777, 0o644)
                self.assertEqual(
                    passfile.read_text(),
                    "postgres:5432:openslate:openslate_inspector:inspector-canary\n",
                )
                caddyfile = Path(child["CADDY_CONFIG_PATH"])
                self.assertEqual(caddyfile.parent.stat().st_mode & 0o777, 0o700)
                self.assertEqual(caddyfile.stat().st_mode & 0o777, 0o644)
                caddy = caddyfile.read_text()
                self.assertIn("https://localhost:3448", caddy)
                self.assertIn("bind 0.0.0.0", caddy)
                self.assertIn("reverse_proxy host.docker.internal:8000", caddy)
                self.assertIn("reverse_proxy host.docker.internal:3000", caddy)
                self.assertIn("auto_https disable_redirects", caddy)

    def test_control_commands_use_safe_compose_defaults_without_optional_runtime_files(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment.write_environment(root / ".env", {})
            for arguments in (
                ["compose", "--profile", "db-ui", "--profile", "gateway", "ps"],
                ["compose", "--profile", "db-ui", "stop", "pgweb"],
            ):
                with self.subTest(arguments=arguments):
                    with (
                        patch.object(environment, "ROOT", root),
                        patch.dict(
                            os.environ,
                            {
                                "CADDY_CONFIG_PATH": "/private/stale-caddyfile",
                                "PGWEB_PASSFILE_PATH": "/private/stale-pgpass",
                            },
                        ),
                        patch.object(environment, "write_pgweb_passfile") as write_pgweb_passfile,
                        patch.object(environment, "write_caddy_config") as write_caddy_config,
                        patch.object(environment.subprocess, "run") as run,
                    ):
                        run.return_value.returncode = 0

                        self.assertEqual(environment.main(arguments), 0)

                    write_pgweb_passfile.assert_not_called()
                    write_caddy_config.assert_not_called()
                    child = run.call_args.kwargs["env"]
                    self.assertEqual(child["POSTGRES_BOOTSTRAP_PASSWORD"], "compose-control-only")
                    self.assertNotIn("PGWEB_PASSFILE_PATH", child)
                    self.assertNotIn("CADDY_CONFIG_PATH", child)

    def test_control_commands_reach_docker_without_a_readable_environment_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for arguments in (
                ["compose", "--profile", "db-ui", "--profile", "gateway", "ps"],
                ["compose", "--profile", "db-ui", "stop", "pgweb"],
            ):
                with self.subTest(arguments=arguments):
                    with (
                        patch.object(environment, "ROOT", root),
                        patch.dict(
                            os.environ,
                            {
                                "POSTGRES_BOOTSTRAP_PASSWORD": "stale-password",
                                "PGWEB_PASSFILE_PATH": "/private/stale-pgpass",
                                "MIGRATION_DATABASE_URL": "postgresql://stale",
                                "ADMIN_PASSWORD": "stale-admin-password",
                                "SEED_ACCESS_TOKEN": "stale-seed-token",
                            },
                        ),
                        patch.object(environment.subprocess, "run") as run,
                    ):
                        run.return_value.returncode = 0

                        self.assertEqual(environment.main(arguments), 0)

                    child = run.call_args.kwargs["env"]
                    self.assertEqual(child["POSTGRES_BOOTSTRAP_PASSWORD"], "compose-control-only")
                    forbidden = {
                        "PGWEB_PASSFILE_PATH",
                        "MIGRATION_DATABASE_URL",
                        "ADMIN_PASSWORD",
                        "SEED_ACCESS_TOKEN",
                    }
                    self.assertFalse(forbidden.intersection(child))

    def test_control_commands_reach_docker_with_a_malformed_environment_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text("POSTGRES_DATABASE=one\nPOSTGRES_DATABASE=two\n")
            with (
                patch.object(environment, "ROOT", root),
                patch.object(environment.subprocess, "run") as run,
            ):
                run.return_value.returncode = 0

                self.assertEqual(environment.main(["compose", "ps"]), 0)

            self.assertEqual(
                run.call_args.args[0][-1],
                "ps",
            )

    def test_control_parser_only_bypasses_environment_for_the_actual_subcommand(self) -> None:
        cases = {
            ("--profile", "db-ui", "--profile", "gateway", "ps"): "ps",
            ("--profile=db-ui", "--profile=gateway", "stop", "pgweb"): "stop",
            ("--profile", "stop", "up", "-d", "postgres"): "up",
            ("--profile=ps", "up", "-d", "postgres"): "up",
            ("--profile=", "ps"): None,
            ("--unsupported-option", "ps"): None,
        }

        for arguments, expected in cases.items():
            with self.subTest(arguments=arguments):
                self.assertEqual(environment.compose_subcommand(list(arguments)), expected)

    def test_profile_value_cannot_make_an_up_command_bypass_environment_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for arguments in (
                ["compose", "--profile", "stop", "up", "-d", "postgres"],
                ["compose", "--profile=ps", "up", "-d", "postgres"],
            ):
                with self.subTest(arguments=arguments):
                    output = io.StringIO()
                    with (
                        patch.object(environment, "ROOT", root),
                        patch.object(environment.subprocess, "run") as run,
                        redirect_stderr(output),
                    ):
                        self.assertEqual(environment.main(arguments), 2)
                    run.assert_not_called()
                    self.assertIn("Environment file is unavailable", output.getvalue())

    def test_start_check_and_frontend_remain_closed_when_environment_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for arguments in (
                ["compose", "up", "-d", "postgres"],
                ["check"],
                ["frontend"],
            ):
                with self.subTest(arguments=arguments):
                    output = io.StringIO()
                    with (
                        patch.object(environment, "ROOT", root),
                        patch.object(environment.subprocess, "run") as run,
                        redirect_stderr(output),
                    ):
                        self.assertEqual(environment.main(arguments), 2)
                    run.assert_not_called()
                    self.assertIn("Environment file is unavailable", output.getvalue())

    def test_reset_instructions_remove_only_the_postgres_container_and_volume(self) -> None:
        readme = (environment.ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("docker compose rm --stop --force postgres", readme)
        self.assertIn("docker volume rm openslate_postgres-data", readme)
        self.assertNotIn("docker compose --profile db-ui --profile gateway down -v", readme)


if __name__ == "__main__":
    unittest.main()
