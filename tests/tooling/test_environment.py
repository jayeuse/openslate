"""The developer wrapper admits only its own Supabase installation."""

import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "project_environment_supabase", ROOT / "scripts/environment.py"
)
assert spec is not None and spec.loader is not None
environment = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = environment
spec.loader.exec_module(environment)

from operations.supabase_keys import realtime_secrets  # noqa: E402

REALTIME_SIGNING_KEY = realtime_secrets()[0]["REALTIME_TOKEN_SIGNING_KEY"]


def fixture() -> dict[str, str]:
    values = environment.read_environment(ROOT / ".env.example")
    values.update(
        POSTGRES_PASSWORD="database-secret",
        JWT_SECRET="jwt-secret" * 8,
        JWT_KEYS='[{"kty":"EC"}]',
        JWT_JWKS='{"keys":[]}',
        ANON_KEY="anon-canary",
        SERVICE_ROLE_KEY="service-canary",
        ANON_KEY_ASYMMETRIC="asymmetric-anon-canary",
        SERVICE_ROLE_KEY_ASYMMETRIC="asymmetric-service-canary",
        SUPABASE_PUBLISHABLE_KEY="sb_publishable_canary",
        SUPABASE_SECRET_KEY="sb_secret_canary",
        PG_META_CRYPTO_KEY="meta-canary",
        DASHBOARD_USERNAME="operator",
        DASHBOARD_PASSWORD="dashboard-canary",
        SMTP_ADMIN_EMAIL="admin@example.test",
        SMTP_HOST="mailpit",
        SMTP_PORT="1025",
        SMTP_USER="",
        SMTP_PASS="",
        DATABASE_BOOTSTRAP_URL="postgresql+psycopg://supabase_admin:database-secret@127.0.0.1:55432/postgres",
        MIGRATION_DATABASE_URL="postgresql+psycopg://openslate_owner:owner-secret@127.0.0.1:55432/postgres",
        DATABASE_URL="postgresql+psycopg://openslate_runtime:runtime-secret@127.0.0.1:55432/postgres",
        SUPABASE_SESSION_ENCRYPTION_KEY=Fernet.generate_key().decode("ascii"),
        PUBLICATION_SIGNING_KEY="a" * 64,
        REALTIME_TOKEN_SIGNING_KEY=REALTIME_SIGNING_KEY,
        REALTIME_SECRET_KEY_BASE="realtime-base-canary" * 4,
        REALTIME_DB_ENC_KEY="k" * 16,
        SECURITY_EVENT_SERVER_KEY="security-canary",
    )
    return values


class SupabaseEnvironmentTests(unittest.TestCase):
    def test_all_example_keys_are_declared_and_retired_names_are_rejected(self) -> None:
        names = set(environment.read_environment(ROOT / ".env.example"))
        self.assertFalse(names - environment.ROOT_ENVIRONMENT_KEYS)
        for retired in ("PGWEB_PORT", "DATABASE_INSPECTOR_URL", "POSTGRES_BOOTSTRAP_PASSWORD"):
            with self.subTest(retired=retired), self.assertRaises(environment.ConfigurationError):
                environment.validate({**fixture(), retired: "canary"})

    def test_static_assets_stay_optional_but_must_be_absolute_when_set(self) -> None:
        values = fixture()
        values.pop("WEB_ASSETS_ROOT", None)
        environment.validate(values)
        with self.assertRaises(environment.ConfigurationError):
            environment.validate({**values, "WEB_ASSETS_ROOT": "relative/assets"})

    def test_development_origin_preserves_local_and_lan_browser_admission(self) -> None:
        values = fixture()
        for origin in (
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
            "http://192.168.1.20:3000",
            "http://169.254.10.20:3000",
            "https://192.168.1.20:3000",
        ):
            with self.subTest(origin=origin):
                environment.validate(
                    {
                        **values,
                        "PUBLIC_ORIGIN": origin,
                        "SITE_URL": origin,
                    }
                )
        for origin in (
            "https://0.0.0.0:3000",
            "https://192.0.2.1:3000",
            "https://224.0.0.1:3000",
            "https://[::]:3000",
            "https://[2001:db8::1]:3000",
            "https://[ff02::1]:3000",
        ):
            with self.subTest(origin=origin), self.assertRaises(environment.ConfigurationError):
                environment.validate(
                    {
                        **values,
                        "PUBLIC_ORIGIN": origin,
                        "SITE_URL": origin,
                    }
                )
        for name, value in (
            ("PUBLIC_ORIGIN", "http://localhost:3001"),
        ):
            with self.subTest(name=name), self.assertRaises(environment.ConfigurationError):
                environment.validate({**values, name: value})

    def test_non_loopback_development_retains_strict_transport(self) -> None:
        values = {
            **fixture(),
            "BACKEND_BIND_HOST": "0.0.0.0",
            "PUBLIC_ORIGIN": "http://192.168.1.20:3000",
            "SITE_URL": "http://192.168.1.20:3000",
        }
        with self.assertRaises(environment.ConfigurationError):
            environment.validate(values)

    def test_caddy_gateway_keeps_platform_specific_upstream_and_collision_guard(self) -> None:
        values = fixture()
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(environment, "ROOT", Path(directory)),
                patch.object(environment.sys, "platform", "darwin"),
            ):
                config = environment.write_caddy_config(values).read_text(encoding="utf-8")
                self.assertIn("reverse_proxy host.docker.internal:8000", config)
                self.assertNotIn("frontend", config.lower())
            with (
                patch.object(environment, "ROOT", Path(directory)),
                patch.object(environment.sys, "platform", "linux"),
            ):
                config = environment.write_caddy_config(values).read_text(encoding="utf-8")
                self.assertIn("bind 127.0.0.1", config)
                self.assertIn("reverse_proxy 127.0.0.1:8000", config)
                self.assertEqual(
                    environment.compose_files(["--profile", "gateway", "up", "caddy"]),
                    [Path(directory) / "compose.yaml", environment.LINUX_CADDY_COMPOSE_PATH],
                )
            with self.assertRaises(environment.ConfigurationError):
                environment.write_caddy_config({**values, "GATEWAY_PORT": "8000"})

    def test_provider_database_urls_keep_distinct_roles_and_one_endpoint(self) -> None:
        values = fixture()
        environment.validate(values)
        for name, replacement in (
            ("DATABASE_URL", values["MIGRATION_DATABASE_URL"]),
            ("MIGRATION_DATABASE_URL", values["DATABASE_URL"]),
            ("DATABASE_BOOTSTRAP_URL", values["DATABASE_URL"]),
            ("DATABASE_URL", values["DATABASE_URL"].replace(":55432/", ":55433/")),
        ):
            with self.subTest(name=name), self.assertRaises(environment.ConfigurationError):
                environment.validate({**values, name: replacement})

    def test_provider_smtp_port_is_validated_before_compose(self) -> None:
        with self.assertRaises(environment.ConfigurationError):
            environment.validate({**fixture(), "SMTP_PORT": "not-a-port"})

    def test_provider_urls_are_bound_to_one_auth_issuer_and_browser_origin(self) -> None:
        values = fixture()
        for name in ("API_EXTERNAL_URL", "SITE_URL", "SUPABASE_URL", "SUPABASE_PUBLIC_URL"):
            with self.subTest(name=name), self.assertRaises(environment.ConfigurationError):
                environment.validate({**values, name: "https://other.example.test"})

    def test_private_provider_secrets_are_projected_only_to_supabase_compose(self) -> None:
        values = fixture()
        projected = environment.compose_environment(values, services={"db"})
        self.assertEqual(projected["POSTGRES_PASSWORD"], "database-secret")
        self.assertEqual(projected["OPENSLATE_INSTANCE_ID"], values["OPENSLATE_INSTANCE_ID"])
        for name in (
            "DATABASE_URL",
            "MIGRATION_DATABASE_URL",
            "ADMIN_PASSWORD",
            "SUPABASE_SESSION_ENCRYPTION_KEY",
        ):
            self.assertFalse(name in projected)
        self.assertEqual(
            environment.compose_environment(values, services={"caddy"})["GATEWAY_PORT"],
            values["GATEWAY_PORT"],
        )

    def test_compose_paths_use_provider_files_and_keep_caddy_independent(self) -> None:
        self.assertEqual(
            environment.compose_files(["up", "-d", "db"]),
            [ROOT / "infra/supabase/compose.yaml", ROOT / "infra/supabase/compose.dev.yaml"],
        )
        self.assertEqual(environment.compose_files(["up", "-d", "caddy"])[0], ROOT / "compose.yaml")

    def test_database_guard_pin_matches_provider_compose(self) -> None:
        compose = (ROOT / "infra/supabase/compose.yaml").read_text(encoding="utf-8")
        self.assertIn(f"image: {environment.SUPABASE_DB_IMAGE}", compose)

    def test_stale_shell_values_cannot_replace_private_instance_values(self) -> None:
        values = fixture()
        projected = environment.compose_environment(values, services={"db"})
        with patch.dict(
            os.environ,
            {
                "POSTGRES_PASSWORD": "stale",
                "COMPOSE_FILE": "wrong",
                "UNRELATED_SECRET": "must-not-reach-compose",
            },
        ):
            with patch.object(environment.subprocess, "run") as run:
                run.return_value.returncode = 0
                environment.run_compose(["config", "--quiet"], projected)
        self.assertEqual(run.call_args.kwargs["env"]["POSTGRES_PASSWORD"], "database-secret")
        self.assertFalse("COMPOSE_FILE" in run.call_args.kwargs["env"])
        self.assertFalse("UNRELATED_SECRET" in run.call_args.kwargs["env"])
        command = run.call_args.args[0]
        self.assertNotIn("stale", str(command))
        self.assertEqual(
            command[command.index("--project-directory") + 1], str(ROOT / "infra/supabase")
        )

    def test_caddy_compose_keeps_root_project_directory(self) -> None:
        values = fixture()
        projected = environment.compose_environment(values, services={"caddy"})
        with patch.object(environment.subprocess, "run") as run:
            run.return_value.returncode = 0
            environment.run_compose(["up", "-d", "caddy"], projected)
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("--project-directory") + 1], str(ROOT))

    def test_config_output_and_scope_overrides_are_rejected(self) -> None:
        for arguments in (
            ["config"],
            ["config", "--quiet", "--output", "/tmp/secret.yml"],
            ["down", "--volumes"],
            ["exec", "db", "sh"],
            ["--profile", "up", "exec", "db", "sh"],
            ["-f", "other.yml", "up", "db"],
            ["--project-name", "other", "up", "db"],
            ["--env-file", "/tmp/other", "up", "db"],
        ):
            with (
                self.subTest(arguments=arguments),
                self.assertRaises(environment.ConfigurationError),
            ):
                environment.reject_compose_scope_overrides(arguments)

    def test_legacy_attestation_cannot_admit_new_provider_volume(self) -> None:
        values = fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / ".agent-runtime/instances/openslate.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({"ownership": {"volume": "openslate_postgres-data"}}))
            path.chmod(0o600)
            with patch.object(environment, "ROOT", root):
                with self.assertRaises(environment.ConfigurationError):
                    environment._read_instance_attestation(values)

    def test_new_attestation_is_private_versioned_and_bound_to_provider(self) -> None:
        values = fixture()
        ownership: dict[str, object] = {
            "compose_project": "openslate",
            "container_id": "a" * 64,
            "image": environment.SUPABASE_DB_IMAGE,
            "working_dir": str(environment.SUPABASE_COMPOSE_PATH.parent),
            "network": "openslate_provider",
            "network_id": "b" * 64,
            "volume": "openslate_supabase-db-data",
            "host_port": 55432,
            "container_port": 5432,
        }
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(environment, "ROOT", Path(directory)):
                path = environment.write_instance_attestation(values, ownership)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                read_path, payload = environment._read_instance_attestation(values)
                self.assertEqual(read_path, path)
                self.assertEqual(payload["version"], 2)
                self.assertEqual(payload["ownership"], ownership)

    def test_docker_inspection_binds_pinned_database_container_and_volume(self) -> None:
        values = fixture()
        identity = values["OPENSLATE_INSTANCE_ID"]
        container = {
            "Id": "a" * 64,
            "State": {"Running": True},
            "Config": {
                "Image": environment.SUPABASE_DB_IMAGE,
                "Labels": {
                    "com.docker.compose.project": identity,
                    "com.docker.compose.project.working_dir": str(
                        environment.SUPABASE_COMPOSE_PATH.parent
                    ),
                    "com.docker.compose.service": "db",
                },
            },
            "Mounts": [
                {
                    "Type": "volume",
                    "Destination": "/var/lib/postgresql/data",
                    "Name": f"{identity}_supabase-db-data",
                }
            ],
            "NetworkSettings": {"Networks": {f"{identity}_provider": {"NetworkID": "b" * 64}}},
            "HostConfig": {
                "PortBindings": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "55432"}]}
            },
        }
        network = {
            "Id": "b" * 64,
            "Labels": {
                "com.docker.compose.project": identity,
                "com.docker.compose.network": "provider",
            },
        }
        volume = {
            "Name": f"{identity}_supabase-db-data",
            "Labels": {
                "com.docker.compose.project": identity,
                "com.docker.compose.volume": "supabase-db-data",
            },
        }
        with patch.object(environment, "_compose_project_containers", return_value=["a" * 64]):
            with patch.object(
                environment, "_docker_json", side_effect=[[container], [network], [volume]]
            ):
                ownership = environment.inspect_instance_ownership(values)
            self.assertEqual(ownership["volume"], f"{identity}_supabase-db-data")
            self.assertEqual(ownership["image"], environment.SUPABASE_DB_IMAGE)
            container["Config"]["Image"] = "postgres:17"
            with patch.object(
                environment, "_docker_json", side_effect=[[container], [network], [volume]]
            ):
                with self.assertRaises(environment.ConfigurationError):
                    environment.inspect_instance_ownership(values)

    def test_existing_unattested_provider_data_blocks_start(self) -> None:
        values = {**fixture(), "OPENSLATE_INSTANCE_ID": "supabase-guard-test"}
        with (
            patch.object(environment, "_compose_project_containers", return_value=[]),
            patch.object(
                environment,
                "_docker_output",
                side_effect=[
                    "",
                    "",
                    "supabase-guard-test_supabase-db-data\n",
                    "",
                ],
            ),
            patch.object(
                environment,
                "_verify_attested_resources",
                side_effect=environment.ConfigurationError("unattested"),
            ),
        ):
            with self.assertRaises(environment.ConfigurationError):
                environment._preflight_compose_mutation(values, "up", ["up", "-d"])

    def test_legacy_project_data_is_rejected_before_new_start(self) -> None:
        values = {**fixture(), "OPENSLATE_INSTANCE_ID": "supabase-guard-test"}
        with patch.object(
            environment, "_docker_output", return_value="supabase-guard-test_postgres-data\n"
        ):
            with patch.object(environment, "_compose_project_containers") as discover:
                with self.assertRaisesRegex(environment.ConfigurationError, "legacy"):
                    environment._preflight_compose_mutation(values, "up", ["up", "-d"])
            discover.assert_not_called()

    def test_control_commands_require_live_attested_container(self) -> None:
        values = fixture()
        with (
            patch.object(environment, "_reject_legacy_resources"),
            patch.object(environment, "_compose_project_containers", return_value=["a" * 64]),
            patch.object(
                environment,
                "_verify_live_instance",
                side_effect=environment.ConfigurationError("unowned"),
            ),
        ):
            for arguments in (["up", "-d"], ["stop"], ["down"]):
                with (
                    self.subTest(arguments=arguments),
                    self.assertRaises(environment.ConfigurationError),
                ):
                    environment._preflight_compose_mutation(values, arguments[0], arguments)

    def test_attested_retained_volume_allows_a_scoped_restart(self) -> None:
        values = fixture()
        with (
            patch.object(environment, "_reject_legacy_resources"),
            patch.object(environment, "_compose_project_containers", return_value=[]),
            patch.object(
                environment, "_docker_output", side_effect=["openslate_supabase-db-data\n", ""]
            ),
            patch.object(environment, "_verify_attested_resources") as verify,
        ):
            environment._preflight_compose_mutation(values, "up", ["up", "-d"])
        verify.assert_called_once_with(values)

    def test_explicit_env_file_is_supported_and_old_reset_is_retired(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "new-install.env"
            path.write_text("# private\n", encoding="utf-8")
            path.chmod(0o600)
            with patch.object(environment, "read_environment", return_value=fixture()) as read:
                with patch.object(environment, "run_compose", return_value=0):
                    self.assertEqual(
                        environment.main(["--env-file", str(path), "compose", "config", "--quiet"]),
                        0,
                    )
            read.assert_called_once_with(path)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            environment.main(["reset-database"])

    def test_partial_start_records_verified_database_for_safe_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "installation.env"
            path.write_text("# private\n", encoding="utf-8")
            path.chmod(0o600)
            ownership = {"container_id": "a" * 64}
            values = fixture()
            with (
                patch.object(environment, "read_environment", return_value=values),
                patch.object(environment, "_preflight_compose_mutation"),
                patch.object(environment, "run_compose", return_value=17),
                patch.object(environment, "inspect_instance_ownership", return_value=ownership),
                patch.object(environment, "write_instance_attestation") as write,
            ):
                self.assertEqual(
                    environment.main(["--env-file", str(path), "compose", "up", "-d"]), 17
                )
            write.assert_called_once_with(values, ownership)

    def test_group_readable_installation_file_is_rejected_before_loading(self) -> None:
        if os.name == "nt":
            self.skipTest("Windows ACL behavior requires a Windows host")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "installation.env"
            path.write_text("POSTGRES_PASSWORD=canary\n", encoding="utf-8")
            path.chmod(0o644)
            with (
                patch.object(environment, "read_environment") as read,
                redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(environment.main(["--env-file", str(path), "check"]), 2)
            read.assert_not_called()

    def test_local_wrapper_cannot_launch_a_production_installation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "installation.env"
            path.write_text("# private\n", encoding="utf-8")
            path.chmod(0o600)
            with (
                patch.object(
                    environment,
                    "read_environment",
                    return_value={**fixture(), "ENVIRONMENT": "production"},
                ),
                patch.object(environment, "validate"),
                patch.object(environment, "run_compose") as run,
                redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(
                    environment.main(["--env-file", str(path), "compose", "config", "--quiet"]),
                    2,
                )
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
