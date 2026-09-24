"""Configuration validation keeps service boundaries explicit."""

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

    def test_static_asset_root_must_be_absolute(self) -> None:
        values = {**fixture(), "WEB_ASSETS_ROOT": "relative/assets"}

        with self.assertRaises(environment.ConfigurationError) as raised:
            environment.validate(values)

        self.assertIn("WEB_ASSETS_ROOT", str(raised.exception))

    def test_development_does_not_require_a_static_asset_root(self) -> None:
        values = fixture()
        values.pop("WEB_ASSETS_ROOT", None)

        environment.validate(values)

    def test_loopback_development_accepts_local_next_origins_without_gateway_settings(self) -> None:
        values = fixture()
        environment.validate(values)

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
                        "AUTH_JWT_ISSUER": origin,
                    }
                )

        caddy_free = dict(values)
        for name in ("GATEWAY_PUBLIC_HOST", "GATEWAY_BIND_HOST", "GATEWAY_PORT"):
            caddy_free.pop(name)
        environment.validate(caddy_free)

    def test_loopback_development_rejects_reserved_and_non_unicast_origins(self) -> None:
        values = fixture()

        for origin in (
            "https://0.0.0.0:3000",
            "https://192.0.2.1:3000",
            "https://224.0.0.1:3000",
            "https://[::]:3000",
            "https://[2001:db8::1]:3000",
            "https://[ff02::1]:3000",
        ):
            with self.subTest(origin=origin):
                with self.assertRaises(environment.ConfigurationError) as raised:
                    environment.validate(
                        {
                            **values,
                            "PUBLIC_ORIGIN": origin,
                            "AUTH_JWT_ISSUER": origin,
                        }
                    )
                self.assertIn("PUBLIC_ORIGIN", str(raised.exception))

    def test_loopback_development_requires_local_origin_matching_next_port_and_issuer(self) -> None:
        values = fixture()
        cases = (
            ("PUBLIC_ORIGIN", "http://localhost:3001"),
            ("PUBLIC_ORIGIN", "https://example.test:3000"),
            ("AUTH_JWT_ISSUER", "http://localhost:3000"),
        )

        for name, value in cases:
            with self.subTest(name=name, value=value):
                invalid = {
                    **values,
                    "PUBLIC_ORIGIN": "http://192.168.1.20:3000",
                    "AUTH_JWT_ISSUER": "http://192.168.1.20:3000",
                    name: value,
                }
                with self.assertRaises(environment.ConfigurationError) as raised:
                    environment.validate(invalid)
                self.assertIn(name, str(raised.exception))

    def test_loopback_development_rejects_issuer_that_differs_after_origin_normalization(
        self,
    ) -> None:
        values = {
            **fixture(),
            "PUBLIC_ORIGIN": "http://localhost:3000/",
            "AUTH_JWT_ISSUER": "http://localhost:3000/",
        }

        with self.assertRaises(environment.ConfigurationError) as raised:
            environment.validate(values)

        self.assertIn("SETTINGS", str(raised.exception).upper())

    def test_non_loopback_development_retains_strict_http_transport(self) -> None:
        values = {
            **fixture(),
            "BACKEND_BIND_HOST": "0.0.0.0",
            "PUBLIC_ORIGIN": "http://192.168.1.20:3000",
            "AUTH_JWT_ISSUER": "http://192.168.1.20:3000",
        }

        with self.assertRaises(environment.ConfigurationError) as raised:
            environment.validate(values)

        self.assertNotIn("192.168.1.20", str(raised.exception))


    def test_opt_in_gateway_renders_the_production_fastapi_upstream(self) -> None:
        values = fixture()

        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(environment, "ROOT", Path(directory)),
                patch.object(environment.sys, "platform", "darwin"),
            ):
                caddy = environment.write_caddy_config(values).read_text(encoding="utf-8")

        self.assertIn("https://localhost:3448", caddy)
        self.assertIn("reverse_proxy host.docker.internal:8000", caddy)
        self.assertNotIn("frontend", caddy.lower())

    def test_linux_opt_in_gateway_uses_host_network_and_loopback_upstream(self) -> None:
        values = {**fixture(), "GATEWAY_PORT": "4443"}

        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(environment, "ROOT", Path(directory)),
                patch.object(environment.sys, "platform", "linux"),
            ):
                caddy = environment.write_caddy_config(values).read_text(encoding="utf-8")
                compose_files = environment.compose_files(
                    ["--profile", "gateway", "up", "-d", "caddy"]
                )

        self.assertIn("https://localhost:4443", caddy)
        self.assertIn("bind 127.0.0.1", caddy)
        self.assertIn("reverse_proxy 127.0.0.1:8000", caddy)
        self.assertNotIn("host.docker.internal", caddy)
        self.assertEqual(
            compose_files,
            [Path(directory) / "compose.yaml", environment.LINUX_CADDY_COMPOSE_PATH],
        )

    def test_opt_in_gateway_rejects_a_published_host_port_collision(self) -> None:
        values = {**fixture(), "GATEWAY_PORT": "8000"}

        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(environment, "ROOT", Path(directory)),
                patch.object(environment.sys, "platform", "darwin"),
                self.assertRaises(environment.ConfigurationError) as raised,
            ):
                environment.write_caddy_config(values)

        self.assertIn("GATEWAY_PORT", str(raised.exception))
        self.assertIn("BACKEND_PORT", str(raised.exception))

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
                "OPENSLATE_INSTANCE_ID": "openslate",
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
                "OPENSLATE_INSTANCE_ID": "openslate",
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
                patch.object(environment, "inspect_instance_ownership") as inspect,
                patch.object(environment.subprocess, "run") as run,
            ):
                run.return_value.returncode = 0
                run.return_value.stdout = ""
                inspect.return_value = {
                    "compose_project": "openslate",
                    "container_id": "a" * 64,
                    "container_port": 5432,
                    "host_port": 54322,
                    "image": "postgres:17",
                    "working_dir": str(root),
                    "network": "openslate_default",
                    "network_id": "b" * 64,
                    "volume": "openslate_postgres-data",
                }

                self.assertEqual(environment.main(["compose", "up", "-d", "postgres"]), 0)

            write_pgweb_passfile.assert_not_called()
            child = run.call_args.kwargs["env"]
            self.assertEqual(child["POSTGRES_DATABASE"], "openslate")
            self.assertNotIn("DATABASE_URL", child)
            self.assertNotIn("PGWEB_PASSFILE_PATH", child)

    def test_database_start_writes_a_private_instance_attestation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = fixture()
            values["OPENSLATE_INSTANCE_ROOT"] = str(root / "instance")
            values["FILES_STORAGE_ROOT"] = str(root / "instance" / "private-files")
            values["LOG_DIR"] = str(root / "instance" / "backend" / "logs")
            environment.write_environment(root / ".env", values)
            with (
                patch.object(environment, "ROOT", root),
                patch.object(environment, "inspect_instance_ownership") as inspect,
                patch.object(environment.subprocess, "run") as run,
            ):
                run.return_value.returncode = 0
                run.return_value.stdout = ""
                inspect.return_value = {
                    "compose_project": "openslate",
                    "container_id": "a" * 64,
                    "container_port": 5432,
                    "host_port": 54322,
                    "image": "postgres:17",
                    "working_dir": str(root),
                    "network": "openslate_default",
                    "network_id": "b" * 64,
                    "volume": "openslate_postgres-data",
                }
                self.assertEqual(environment.main(["compose", "up", "-d", "postgres"]), 0)

            attestation = root / ".agent-runtime" / "instances" / "openslate.json"
            self.assertEqual(attestation.stat().st_mode & 0o777, 0o600)
            self.assertEqual(
                json.loads(attestation.read_text(encoding="utf-8"))["compose"],
                {"volume": "openslate_postgres-data", "network": "openslate_default"},
            )
            command = run.call_args.args[0]
            self.assertIn("--project-name", command)
            self.assertIn("openslate", command)

    def test_live_docker_ownership_requires_this_worktree_and_compose_resources(self) -> None:
        values = fixture()
        container = {
            "Id": "a" * 64,
            "Config": {
                "Image": "postgres:17@sha256:example",
                "Labels": {
                    "com.docker.compose.project": "openslate",
                    "com.docker.compose.project.working_dir": str(environment.ROOT),
                    "com.docker.compose.service": "postgres",
                },
            },
            "State": {"Running": True},
            "Mounts": [
                {
                    "Type": "volume",
                    "Name": "openslate_postgres-data",
                    "Destination": "/var/lib/postgresql/data",
                }
            ],
            "NetworkSettings": {
                "Networks": {"openslate_default": {"NetworkID": "b" * 64}},
            },
            "HostConfig": {
                "PortBindings": {
                    "5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "54322"}]
                }
            },
        }
        with patch.object(environment.subprocess, "run") as run:
            run.side_effect = [
                type("Result", (), {"returncode": 0, "stdout": "a" * 64 + "\n"})(),
                type("Result", (), {"returncode": 0, "stdout": json.dumps([container])})(),
                type(
                    "Result",
                    (),
                    {
                        "returncode": 0,
                        "stdout": json.dumps(
                            [{
                                "Id": "b" * 64,
                                "Labels": {
                                    "com.docker.compose.project": "openslate",
                                    "com.docker.compose.network": "default",
                                },
                            }]
                        ),
                    },
                )(),
                type(
                    "Result",
                    (),
                    {
                        "returncode": 0,
                        "stdout": json.dumps(
                            [{
                                "Name": "openslate_postgres-data",
                                "Labels": {
                                    "com.docker.compose.project": "openslate",
                                    "com.docker.compose.volume": "postgres-data",
                                },
                            }]
                        ),
                    },
                )(),
            ]
            evidence = environment.inspect_instance_ownership(values)

        self.assertEqual(evidence["container_id"], "a" * 64)
        self.assertEqual(evidence["network"], "openslate_default")
        self.assertEqual(evidence["network_id"], "b" * 64)
        self.assertEqual(evidence["host_port"], 54322)

    def test_stopped_container_is_accepted_only_for_scoped_control_inspection(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = fixture()
            values["OPENSLATE_INSTANCE_ROOT"] = str(root / "instance")
            values["FILES_STORAGE_ROOT"] = str(root / "instance" / "private-files")
            values["LOG_DIR"] = str(root / "instance" / "backend" / "logs")
            environment.write_environment(root / ".env", values)
            container = {
                "Id": "a" * 64,
                "Config": {
                    "Image": "postgres:17@sha256:example",
                    "Labels": {
                        "com.docker.compose.project": "openslate",
                        "com.docker.compose.project.working_dir": str(root),
                        "com.docker.compose.service": "postgres",
                    },
                },
                "State": {"Running": False},
                "Mounts": [
                    {
                        "Type": "volume",
                        "Name": "openslate_postgres-data",
                        "Destination": "/var/lib/postgresql/data",
                    }
                ],
                "NetworkSettings": {
                    "Networks": {"openslate_default": {"NetworkID": "b" * 64}},
                },
                "HostConfig": {
                    "PortBindings": {
                        "5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "54322"}]
                    }
                },
            }
            def docker_inspection_results():
                return [
                        type("Result", (), {"returncode": 0, "stdout": "a" * 64 + "\n"})(),
                        type("Result", (), {"returncode": 0, "stdout": json.dumps([container])})(),
                        type(
                            "Result",
                            (),
                            {
                                "returncode": 0,
                                "stdout": json.dumps(
                                    [{
                                        "Id": "b" * 64,
                                        "Labels": {
                                            "com.docker.compose.project": "openslate",
                                            "com.docker.compose.network": "default",
                                        },
                                    }]
                                ),
                            },
                        )(),
                        type(
                            "Result",
                            (),
                            {
                                "returncode": 0,
                                "stdout": json.dumps(
                                    [{
                                        "Name": "openslate_postgres-data",
                                        "Labels": {
                                            "com.docker.compose.project": "openslate",
                                            "com.docker.compose.volume": "postgres-data",
                                        },
                                    }]
                                ),
                            },
                        )(),
                    ]

            with patch.object(environment, "ROOT", root):
                with patch.object(environment.subprocess, "run") as inspect_run:
                    inspect_run.side_effect = docker_inspection_results()
                    with self.assertRaises(environment.ConfigurationError):
                        environment.inspect_instance_ownership(values)
                    inspect_run.side_effect = docker_inspection_results()
                    ownership = environment.inspect_instance_ownership(
                        values, allow_stopped=True
                    )
                    self.assertEqual(ownership["container_id"], "a" * 64)

                with (
                    patch.object(
                        environment, "_compose_project_containers", return_value=["a" * 64]
                    ),
                    patch.object(
                        environment,
                        "inspect_instance_ownership",
                        return_value={"container_id": "a" * 64},
                    ) as inspect,
                    patch.object(environment.subprocess, "run") as compose_run,
                ):
                    compose_run.return_value.returncode = 0
                    self.assertEqual(environment.main(["compose", "ps"]), 0)
            inspect.assert_called_once_with(values, allow_stopped=True)
            compose_run.assert_called_once()
            self.assertEqual(compose_run.call_args.args[0][-1], "ps")

    def test_down_verifies_attested_stopped_instance_without_removing_named_volumes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = fixture()
            values["OPENSLATE_INSTANCE_ROOT"] = str(root / "instance")
            values["FILES_STORAGE_ROOT"] = str(root / "instance" / "private-files")
            values["LOG_DIR"] = str(root / "instance" / "backend" / "logs")
            environment.write_environment(root / ".env", values)
            attestation = root / ".agent-runtime" / "instances" / "openslate.json"
            attestation.parent.mkdir(parents=True)
            attestation.write_text("attested")
            with (
                patch.object(environment, "ROOT", root),
                patch.object(environment, "_compose_project_containers", return_value=["a" * 64]),
                patch.object(
                    environment,
                    "inspect_instance_ownership",
                    return_value={"container_id": "a" * 64},
                ) as inspect,
                patch.object(
                    environment,
                    "_read_instance_attestation",
                    return_value=(
                        attestation,
                        {"ownership": {"container_id": "a" * 64}},
                    ),
                ),
                patch.object(environment.subprocess, "run") as run,
            ):
                run.return_value.returncode = 0
                self.assertEqual(environment.main(["compose", "down"]), 0)

            inspect.assert_called_once_with(values, allow_stopped=True)
            self.assertTrue(attestation.exists())
            command = run.call_args.args[0]
            self.assertIn("--project-name", command)
            self.assertIn("openslate", command)
            self.assertEqual(command[-1], "down")

    def test_retained_attested_volume_can_restart_after_compose_removed_network(self) -> None:
        values = fixture()
        identity = "openslate"
        volume = {
            "Name": f"{identity}_postgres-data",
            "Labels": {
                "com.docker.compose.project": identity,
                "com.docker.compose.volume": "postgres-data",
            },
        }
        ownership = {"network_id": "b" * 64}
        with (
            patch.object(
                environment,
                "_read_instance_attestation",
                return_value=(Path("/tmp/attestation.json"), {"ownership": ownership}),
            ),
            patch.object(environment, "_docker_output", return_value=""),
            patch.object(environment, "_docker_json", return_value=[volume]) as inspect,
        ):
            environment._verify_attested_resources(values)

        inspect.assert_called_once_with(["volume", "inspect", "openslate_postgres-data"])

    def test_reset_database_removes_only_the_attested_postgres_volume(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = fixture()
            values["OPENSLATE_INSTANCE_ROOT"] = str(root / "instance")
            values["FILES_STORAGE_ROOT"] = str(root / "instance" / "private-files")
            values["LOG_DIR"] = str(root / "instance" / "backend" / "logs")
            identity = "openslate"
            container_id = "a" * 64
            attestation = root / ".agent-runtime" / "instances" / f"{identity}.json"
            attestation.parent.mkdir(parents=True)
            attestation.write_text("attested")
            ownership = {
                "container_id": container_id,
                "image": "postgres:17@sha256:example",
                "working_dir": str(root),
                "compose_project": identity,
                "network": f"{identity}_default",
                "network_id": "b" * 64,
                "volume": f"{identity}_postgres-data",
                "host_port": 54322,
                "container_port": 5432,
            }
            volume = {
                "Name": f"{identity}_postgres-data",
                "Labels": {
                    "com.docker.compose.project": identity,
                    "com.docker.compose.volume": "postgres-data",
                },
            }
            with (
                patch.object(environment, "ROOT", root),
                patch.object(
                    environment,
                    "_read_instance_attestation",
                    return_value=(attestation, {"ownership": ownership}),
                ),
                patch.object(
                    environment, "_compose_project_containers", return_value=[container_id]
                ),
                patch.object(environment, "_verify_live_instance", return_value=ownership),
                patch.object(environment, "_docker_json", return_value=[volume]),
                patch.object(environment.subprocess, "run") as run,
            ):
                run.return_value.returncode = 0
                environment.reset_database(values)

            commands = [call.args[0] for call in run.call_args_list]
            self.assertEqual(
                commands,
                [
                    ["docker", "rm", "--force", container_id],
                    ["docker", "volume", "rm", "openslate_postgres-data"],
                ],
            )
            self.assertNotIn("openslate_caddy-data", str(commands))
            self.assertFalse(attestation.exists())

    def test_reset_database_refuses_missing_or_mismatched_postgres_ownership(self) -> None:
        values = fixture()
        identity = "openslate"
        volume_name = f"{identity}_postgres-data"
        valid_ownership = {
            "container_id": "a" * 64,
            "image": "postgres:17@sha256:example",
            "working_dir": str(environment.ROOT),
            "compose_project": identity,
            "network": f"{identity}_default",
            "network_id": "b" * 64,
            "volume": volume_name,
            "host_port": 54322,
            "container_port": 5432,
        }
        cases = (
            ("missing attestation", True, None),
            ("missing postgres volume", False, None),
            (
                "mismatched volume labels",
                False,
                {
                    "Name": volume_name,
                    "Labels": {
                        "com.docker.compose.project": "another-project",
                        "com.docker.compose.volume": "postgres-data",
                    },
                },
            ),
        )
        for case, missing_attestation, volume in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                attestation = root / ".agent-runtime" / "instances" / f"{identity}.json"
                if missing_attestation:
                    read_attestation = patch.object(
                        environment,
                        "_read_instance_attestation",
                        side_effect=environment.ConfigurationError("missing attestation"),
                    )
                else:
                    attestation.parent.mkdir(parents=True)
                    attestation.write_text("attested")
                    read_attestation = patch.object(
                        environment,
                        "_read_instance_attestation",
                        return_value=(attestation, {"ownership": valid_ownership}),
                    )
                with (
                    patch.object(environment, "ROOT", root),
                    read_attestation,
                    patch.object(environment, "_compose_project_containers", return_value=[]),
                    patch.object(
                        environment,
                        "_docker_json",
                        return_value=[] if volume is None else [volume],
                    ),
                    patch.object(environment.subprocess, "run") as run,
                ):
                    with self.assertRaises(environment.ConfigurationError):
                        environment.reset_database(values)
                    run.assert_not_called()

    def test_reset_database_refuses_a_container_that_differs_from_its_attestation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = fixture()
            values["OPENSLATE_INSTANCE_ROOT"] = str(root / "instance")
            values["FILES_STORAGE_ROOT"] = str(root / "instance" / "private-files")
            values["LOG_DIR"] = str(root / "instance" / "backend" / "logs")
            attestation = root / ".agent-runtime" / "instances" / "openslate.json"
            attested = {"container_id": "a" * 64, "volume": "openslate_postgres-data"}
            with (
                patch.object(environment, "ROOT", root),
                patch.object(
                    environment,
                    "_read_instance_attestation",
                    return_value=(attestation, {"ownership": attested}),
                ),
                patch.object(
                    environment,
                    "_compose_project_containers",
                    return_value=["a" * 64],
                ),
                patch.object(
                    environment,
                    "_verify_live_instance",
                    return_value={"container_id": "c" * 64, "volume": "openslate_postgres-data"},
                ),
                patch.object(environment.subprocess, "run") as run,
            ):
                with self.assertRaises(environment.ConfigurationError):
                    environment.reset_database(values)

            run.assert_not_called()

    def test_public_compose_wrapper_rejects_down_volume_removal(self) -> None:
        for arguments in (
            ["compose", "down", "--volumes"],
            ["compose", "down", "-v"],
            ["compose", "down", "--volumes=true"],
            ["compose", "--profile", "db-ui", "down", "--volumes"],
        ):
            with self.subTest(arguments=arguments):
                output = io.StringIO()
                with (
                    patch.object(environment.subprocess, "run") as run,
                    redirect_stderr(output),
                ):
                    self.assertEqual(environment.main(arguments), 2)
                run.assert_not_called()
                self.assertIn("reset-database", output.getvalue())

    def test_public_compose_wrapper_rejects_unattested_mutation_commands(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment.write_environment(root / ".env", fixture())
            for arguments in (
                ["compose", "exec", "postgres", "psql"],
                ["compose", "run", "postgres", "psql"],
                ["compose", "create", "postgres"],
                ["compose", "--ansi", "never", "exec", "postgres", "psql"],
            ):
                with self.subTest(arguments=arguments):
                    output = io.StringIO()
                    with (
                        patch.object(environment, "ROOT", root),
                        patch.object(environment, "run_compose") as run_compose,
                        redirect_stderr(output),
                    ):
                        self.assertEqual(environment.main(arguments), 2)
                    run_compose.assert_not_called()
                    self.assertIn("not supported", output.getvalue())

    def test_public_reset_database_command_uses_the_root_environment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            values = fixture()
            values["OPENSLATE_INSTANCE_ROOT"] = str(root / "instance")
            values["FILES_STORAGE_ROOT"] = str(root / "instance" / "private-files")
            values["LOG_DIR"] = str(root / "instance" / "backend" / "logs")
            environment.write_environment(root / ".env", values)
            with (
                patch.object(environment, "ROOT", root),
                patch.object(environment, "reset_database") as reset,
                redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(environment.main(["reset-database"]), 0)

            reset.assert_called_once_with(values)

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

        self.assertIn('"127.0.0.1:${POSTGRES_PORT:?POSTGRES_PORT is required}:5432"', compose)
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

    def test_unknown_and_retired_names_are_rejected_without_echoing_values(self) -> None:
        for name in ("COMPOSE_DATABASE_URL", "FRONTEND_PORT", "CORS_ORIGINS"):
            with self.subTest(name=name):
                values = {**fixture(), name: "private-canary"}
                with self.assertRaises(environment.ConfigurationError) as raised:
                    environment.validate(values)
                self.assertIn(name, str(raised.exception))
                self.assertNotIn("private-canary", str(raised.exception))

    def test_compose_uses_projected_values_instead_of_stale_shell(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment.write_environment(root / ".env", fixture())
            pgweb_directory = root / ".agent-runtime/pgweb"
            pgweb_directory.mkdir(parents=True)
            pgweb_directory.chmod(0o755)
            with (
                patch.object(environment, "ROOT", root),
                patch.dict(
                    os.environ,
                    {
                        "DATABASE_URL": "stale",
                        "SMTP_PASSWORD": "stale",
                        "COMPOSE_PROJECT_NAME": "wrong-project",
                        "COMPOSE_FILE": "/tmp/wrong-compose.yaml",
                    },
                ),
                patch.object(environment.subprocess, "run") as run,
                patch.object(environment, "_compose_project_containers", return_value=[]),
                patch.object(environment, "_docker_output", return_value=""),
                patch.object(
                    environment,
                    "inspect_instance_ownership",
                    return_value={
                        "compose_project": "openslate",
                        "container_id": "a" * 64,
                        "container_port": 5432,
                        "host_port": 54322,
                        "image": "postgres:17",
                        "working_dir": str(root),
                        "network": "openslate_default",
                        "network_id": "b" * 64,
                        "volume": "openslate_postgres-data",
                    },
                ),
                redirect_stdout(io.StringIO()),
            ):
                run.return_value.returncode = 0
                run.return_value.stdout = ""
                self.assertEqual(
                    environment.main(
                        [
                            "compose",
                            "--profile",
                            "db-ui",
                            "up",
                            "-d",
                            "pgweb",
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
                self.assertNotIn("COMPOSE_PROJECT_NAME", child)
                self.assertNotIn("COMPOSE_FILE", child)
                passfile = Path(child["PGWEB_PASSFILE_PATH"])
                self.assertEqual(passfile.parent.stat().st_mode & 0o777, 0o700)
                self.assertEqual(passfile.stat().st_mode & 0o777, 0o644)
                self.assertEqual(
                    passfile.read_text(),
                    "postgres:5432:openslate:openslate_inspector:inspector-canary\n",
                )

    def test_control_commands_refuse_unowned_or_unconfigured_instances(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            environment.write_environment(root / ".env", {})
            for arguments in (
                ["compose", "--profile", "db-ui", "ps"],
                ["compose", "--profile", "db-ui", "stop", "pgweb"],
            ):
                with self.subTest(arguments=arguments):
                    with (
                        patch.object(environment, "ROOT", root),
                        patch.dict(
                            os.environ,
                            {
                                "PGWEB_PASSFILE_PATH": "/private/stale-pgpass",
                            },
                        ),
                        patch.object(environment, "write_pgweb_passfile") as write_pgweb_passfile,
                        patch.object(environment.subprocess, "run") as run,
                    ):
                        run.return_value.returncode = 0

                        self.assertEqual(environment.main(arguments), 2)

                    write_pgweb_passfile.assert_not_called()
                    run.assert_not_called()

    def test_control_commands_require_an_instance_environment_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for arguments in (
                ["compose", "--profile", "db-ui", "ps"],
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

                        self.assertEqual(environment.main(arguments), 2)

                    run.assert_not_called()

    def test_control_commands_reject_a_malformed_environment_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text("POSTGRES_DATABASE=one\nPOSTGRES_DATABASE=two\n")
            with (
                patch.object(environment, "ROOT", root),
                patch.object(environment.subprocess, "run") as run,
            ):
                run.return_value.returncode = 0

                self.assertEqual(environment.main(["compose", "ps"]), 2)

            run.assert_not_called()

    def test_control_parser_only_bypasses_environment_for_the_actual_subcommand(self) -> None:
        cases = {
            ("--profile", "db-ui", "--profile", "unused", "ps"): "ps",
            ("--profile=db-ui", "--profile=unused", "stop", "pgweb"): "stop",
            ("--profile", "stop", "up", "-d", "postgres"): "up",
            ("--profile=ps", "up", "-d", "postgres"): "up",
            ("--profile=", "ps"): None,
            ("--unsupported-option", "ps"): None,
        }

        for arguments, expected in cases.items():
            with self.subTest(arguments=arguments):
                self.assertEqual(environment.compose_subcommand(list(arguments)), expected)

    def test_compose_cannot_override_the_attested_project_file_or_environment(self) -> None:
        for arguments in (
            ["down", "--project-name=another-project"],
            ["stop", "-panother-project"],
            ["ps", "--project-directory", "/tmp/other-tree"],
            ["up", "-f", "/tmp/other-compose.yaml", "postgres"],
            ["config", "--env-file=/tmp/other.env"],
        ):
            with self.subTest(arguments=arguments):
                with self.assertRaises(environment.ConfigurationError):
                    environment.reject_compose_scope_overrides(arguments)

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

    def test_start_and_check_remain_closed_when_environment_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for arguments in (
                ["compose", "up", "-d", "postgres"],
                ["check"],
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

    def test_reset_instructions_are_instance_scoped(self) -> None:
        readme = (environment.ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("scripts/environment.py reset-database", readme)
        self.assertNotIn("compose down --volumes", readme)
        self.assertNotIn("docker volume rm openslate_postgres-data", readme)


if __name__ == "__main__":
    unittest.main()
