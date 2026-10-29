"""Static contract tests for the generated Caddy single-origin gateway."""

from __future__ import annotations

import argparse
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import xml.etree.ElementTree as ElementTree
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CADDY_DIR = ROOT / "infra" / "caddy"
CADDY_IMAGE = "caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"
sys.path.insert(0, str(CADDY_DIR))
import generate_config  # noqa: E402


class CaddyGatewayTests(unittest.TestCase):
    def render(self, **overrides: object) -> str:
        settings: dict[str, object] = {
            "public_host": "portal.example.invalid",
            "listen_address": "0.0.0.0",
            "https_port": 443,
            "health_port": 3449,
            "backend_port": 8100,
            "tls_mode": "internal",
            "cert_file": None,
            "key_file": None,
        }
        settings.update(overrides)
        return generate_config.render_config(**settings)  # type: ignore[arg-type]

    def test_production_routes_are_ordered_and_use_only_the_fastapi_upstream(self) -> None:
        rendered = self.render()

        self.assertLess(rendered.index("handle @events"), rendered.index("handle @api"))
        self.assertLess(
            rendered.index("handle @backup_export_content"), rendered.index("handle @api")
        )
        # Comms Realtime ingress is matched before every FastAPI route.
        self.assertLess(rendered.index("handle @realtime"), rendered.index("handle @events"))
        self.assertLess(rendered.index("handle @api"), rendered.index("\n    handle {"))
        self.assertIn("@events path /api/events", rendered)
        self.assertIn("@api path /api /api/*", rendered)
        # Health, events, backup export content, API and the static site.
        self.assertEqual(rendered.count("reverse_proxy 127.0.0.1:8100"), 5)
        self.assertNotIn("FRONTEND_PORT", rendered)
        self.assertNotIn("frontend", rendered.lower())
        self.assertIn("bind 0.0.0.0", rendered)
        self.assertEqual(rendered.count("    bind "), 2)
        # One HTTPS site; the Realtime origin expression also names the public origin.
        self.assertEqual(rendered.count("\nhttps://"), 1)
        self.assertIn("http://127.0.0.1:3449 {\n    bind 127.0.0.1", rendered)
        self.assertIn("@health path /api/health", rendered)
        self.assertIn("auto_https disable_redirects", rendered)
        self.assertIn('Strict-Transport-Security "max-age=31536000"', rendered)
        self.assertNotIn("reverse_proxy 0.0.0.0", rendered)
        self.assertNotIn(":5432", rendered)
        self.assertNotIn(":3310", rendered)
        self.assertNotIn("Access-Control-Allow-Origin", rendered)

    def test_sse_has_its_own_unbuffered_long_lived_contract(self) -> None:
        rendered = self.render()
        events = rendered[rendered.index("handle @events") : rendered.index("handle @api")]

        self.assertIn("flush_interval -1", events)
        self.assertIn("stream_timeout 24h", events)
        self.assertIn("header_up -Accept-Encoding", events)
        self.assertIn("compression off", events)
        self.assertIn("response_header_timeout 30s", events)

    def test_backup_export_content_streams_with_its_own_long_response_window(self) -> None:
        rendered = self.render()
        start = rendered.index("handle @backup_export_content")
        export = rendered[start : rendered.index("handle @api")]

        self.assertIn(
            'path_regexp backup_export_content "^/api/backups/exports/[^/]+/content$"', rendered
        )
        self.assertIn("flush_interval -1", export)
        self.assertIn("header_up -Accept-Encoding", export)
        self.assertIn("compression off", export)
        self.assertIn("response_header_timeout 330s", export)

    def test_fastapi_upstreams_drop_idle_connections_before_uvicorn_closes_them(self) -> None:
        # Four-pack run on 2026-10-29: a request reused a keep-alive connection the API had
        # just closed and failed with no response. Caddy keeps idle upstream connections for
        # 2 minutes by default and replays only idempotent requests on a closed one.
        import re

        rendered = self.render()
        server = int(
            re.search(
                r"^SERVER_KEEP_ALIVE_SECONDS=(\d+)$",
                (ROOT / ".env.example").read_text(encoding="utf-8"),
                re.MULTILINE,
            ).group(1)
        )
        public = rendered[: rendered.index("http://127.0.0.1:")]
        blocks = public.split("reverse_proxy 127.0.0.1:")[1:]
        self.assertEqual(len(blocks), 4)
        for block in blocks:
            start = block.index("transport http {")
            transport = block[start : block.index("}", start)]
            idle = re.search(r"keepalive (\d+)s", transport)
            self.assertIsNotNone(idle, transport)
            self.assertLess(int(idle.group(1)), server)

    def test_container_gateway_uses_the_explicit_host_upstream(self) -> None:
        rendered = self.render(upstream_host="host.docker.internal")

        self.assertEqual(rendered.count("reverse_proxy host.docker.internal:8100"), 5)
        self.assertNotIn("reverse_proxy 127.0.0.1", rendered)

    def test_local_compose_keeps_the_gateway_behind_an_opt_in_profile(self) -> None:
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")

        self.assertIn("  caddy:", compose)
        self.assertIn('profiles: ["gateway"]', compose)
        self.assertIn("source: ${CADDY_CONFIG_PATH:-./.agent-runtime/caddy/Caddyfile}", compose)

    def test_forwarding_contract_is_present_for_every_upstream(self) -> None:
        rendered = self.render()
        # Events, backup export content, API and static-site upstreams keep the host.
        self.assertEqual(rendered.count("header_up Host {http.request.hostport}"), 4)
        for header in (
            "header_up X-Forwarded-For {http.request.remote.host}",
            "header_up X-Forwarded-Host {http.request.hostport}",
            "header_up X-Forwarded-Proto {http.request.scheme}",
        ):
            # The four FastAPI upstreams and the Comms Realtime upstream.
            self.assertEqual(rendered.count(header), 5)
        # Caddy passes these request headers through; setting them forged empty values.
        self.assertNotIn("header_up Origin", rendered)
        self.assertNotIn("header_up X-Request-ID", rendered)

    def test_both_https_modes_render_without_certificate_material(self) -> None:
        internal = self.render()
        custom = self.render(
            tls_mode="custom",
            cert_file=Path("/srv/openslate/tls/certificate.pem"),
            key_file=Path("/srv/openslate/tls/private-key.pem"),
        )

        self.assertIn("tls internal", internal)
        self.assertIn(
            'tls "/srv/openslate/tls/certificate.pem" "/srv/openslate/tls/private-key.pem"',
            custom,
        )
        self.assertIn("http://127.0.0.1:3449 {\n    bind 127.0.0.1", custom)
        self.assertNotIn("tls internal\n}", custom)
        self.assertNotIn("-----BEGIN", internal + custom)
        self.assertNotIn("password", internal.lower() + custom.lower())

    def test_custom_tls_paths_are_quoted_as_single_caddy_tokens(self) -> None:
        rendered = self.render(
            tls_mode="custom",
            cert_file=Path('/srv/Open Slate/cert#1"issuer.pem'),
            key_file=Path("/srv/Open Slate/private\\key.pem"),
        )

        self.assertIn(
            'tls "/srv/Open Slate/cert#1\\"issuer.pem" "/srv/Open Slate/private\\\\key.pem"',
            rendered,
        )

    def test_unicode_absolute_certificate_paths_support_native_and_windows_styles(self) -> None:
        native_path = (
            Path(r"C:\OpenSlate\证书\certificate.pem")
            if os.name == "nt"
            else Path("/srv/Open Slate/证书/certificate.pem")
        )
        native = self.render(
            tls_mode="custom",
            cert_file=native_path,
            key_file=native_path.with_name("private key.pem"),
        )
        windows = self.render(
            tls_mode="custom",
            cert_file=Path(r"C:\Open Slate\证书\certificate.pem"),
            key_file=Path(r"C:\Open Slate\证书\private key.pem"),
        )

        self.assertIn("证书", native)
        self.assertIn('tls "C:\\\\Open Slate\\\\证书\\\\certificate.pem"', windows)

    def test_ipv6_host_and_listener_are_rendered_without_template_injection(self) -> None:
        rendered = self.render(public_host="::1", listen_address="::")

        self.assertIn("https://[::1]:443", rendered)
        self.assertIn("bind ::", rendered)
        self.assertNotIn("{{", rendered)

    def test_generator_rejects_unsafe_inputs(self) -> None:
        with self.assertRaises(argparse.ArgumentTypeError):
            generate_config._public_host("portal.example.invalid\nreverse_proxy attacker")
        with self.assertRaises(argparse.ArgumentTypeError):
            generate_config._listen_address("gateway.example.invalid")
        with self.assertRaises(argparse.ArgumentTypeError):
            generate_config._listen_address("fe80::1%en0")
        with self.assertRaises(argparse.ArgumentTypeError):
            generate_config._listen_address("127.0.0.1\t")
        with self.assertRaises(argparse.ArgumentTypeError):
            generate_config._listen_address("127.0.0.1\x7f")
        with self.assertRaises(argparse.ArgumentTypeError):
            generate_config._port("65536")
        with self.assertRaises(generate_config.ConfigurationError):
            self.render(tls_mode="custom")
        with self.assertRaises(argparse.ArgumentTypeError):
            self.render(
                tls_mode="custom",
                cert_file=Path("relative.pem"),
                key_file=Path("/srv/openslate/tls/private-key.pem"),
            )
        with self.assertRaises(generate_config.ConfigurationError):
            generate_config._caddy_string_token("/srv/openslate/tls/{$CERTIFICATE_FILE}.pem")
        with self.assertRaises(generate_config.ConfigurationError):
            self.render(health_port=443)
        with self.assertRaises(argparse.ArgumentTypeError):
            self.render(
                tls_mode="custom",
                cert_file=Path("/srv/openslate/tls/{$CERTIFICATE_FILE}.pem"),
                key_file=Path("/srv/openslate/tls/private-key.pem"),
            )

    def test_generator_rejects_each_production_host_listener_collision(self) -> None:
        for overrides, labels in (
            ({"https_port": 3449}, ("HTTPS_PORT", "HEALTH_PORT")),
            ({"backend_port": 3449}, ("HEALTH_PORT", "BACKEND_PORT")),
            ({"https_port": 8100}, ("HTTPS_PORT", "BACKEND_PORT")),
        ):
            with self.subTest(overrides=overrides):
                with self.assertRaises(generate_config.ConfigurationError) as raised:
                    self.render(**overrides)

                self.assertIn(labels[0], str(raised.exception))
                self.assertIn(labels[1], str(raised.exception))

    def test_bridged_production_generator_allows_the_container_and_fastapi_port_to_match(
        self,
    ) -> None:
        rendered = self.render(
            https_port=8100,
            backend_port=8100,
            require_host_namespace_separation=False,
        )

        self.assertIn("https://portal.example.invalid:8100", rendered)
        self.assertIn("reverse_proxy 127.0.0.1:8100", rendered)

    def test_loopback_public_host_uses_a_distinct_private_health_listener(self) -> None:
        rendered = self.render(public_host="127.0.0.1")

        self.assertIn("https://127.0.0.1:443", rendered)
        self.assertIn("http://127.0.0.1:3449", rendered)
        self.assertEqual(rendered.count("https://127.0.0.1:443"), 1)
        self.assertIn("bind 127.0.0.1", rendered)

    def test_substitute_examples_keep_the_same_private_routing_contract(self) -> None:
        nginx = (CADDY_DIR / "reference" / "nginx.conf.example").read_text(encoding="utf-8")
        iis = (CADDY_DIR / "reference" / "iis-web.config.example").read_text(encoding="utf-8")

        self.assertLess(nginx.index("location = /api/events"), nginx.index("location = /api {"))
        self.assertLess(nginx.index("location = /api {"), nginx.index("location /api/"))
        self.assertIn("proxy_buffering off", nginx)
        self.assertIn("proxy_read_timeout 24h", nginx)
        self.assertEqual(nginx.count("proxy_pass http://127.0.0.1:<BACKEND_PORT>;"), 4)
        self.assertEqual(nginx.count("proxy_set_header Host $http_host;"), 4)
        self.assertEqual(nginx.count("proxy_set_header X-Forwarded-For $remote_addr;"), 4)
        self.assertEqual(nginx.count("proxy_set_header X-Forwarded-Host $http_host;"), 4)
        self.assertNotIn("Access-Control-Allow-Origin", nginx + iis)
        self.assertIn("Strict-Transport-Security", nginx)
        self.assertIn("Strict-Transport-Security", iis)
        self.assertNotIn("-----BEGIN", nginx + iis)
        ElementTree.fromstring(iis)
        for variable in (
            "HTTP_HOST",
            "HTTP_ORIGIN",
            "HTTP_X_REQUEST_ID",
            "HTTP_X_FORWARDED_FOR",
            "HTTP_X_FORWARDED_HOST",
            "HTTP_X_FORWARDED_PROTO",
        ):
            self.assertIn(f'<add name="{variable}" />', iis)
        self.assertLess(iis.index('name="OpenSlate SSE"'), iis.index('name="OpenSlate API"'))
        self.assertIn("127.0.0.1:&lt;BACKEND_PORT&gt;", iis)
        self.assertNotIn("FRONTEND_PORT", nginx + iis)

    def test_cli_writes_a_resolved_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "Caddyfile"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(CADDY_DIR / "generate_config.py"),
                    "--public-host",
                    "portal.example.invalid",
                    "--output",
                    str(output),
                    "--backend-port",
                    "8100",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(output.read_text(encoding="utf-8"), self.render())

    def test_cli_rejects_removed_development_gateway_arguments(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "Caddyfile"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(CADDY_DIR / "generate_config.py"),
                    "--public-host",
                    "portal.example.invalid",
                    "--output",
                    str(output),
                    "--frontend-dev-port",
                    "3000",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("--frontend-dev-port", completed.stderr)

    def test_cli_rejects_colliding_listener_ports(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            completed = subprocess.run(
                [
                    sys.executable,
                    str(CADDY_DIR / "generate_config.py"),
                    "--public-host",
                    "portal.example.invalid",
                    "--output",
                    str(Path(directory) / "Caddyfile"),
                    "--https-port",
                    "8100",
                    "--backend-port",
                    "8100",
                ],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("HTTPS_PORT", completed.stderr)
        self.assertIn("BACKEND_PORT", completed.stderr)

    @unittest.skipUnless(
        os.getenv("OPENSLATE_RUN_CADDY_ACCEPTANCE") == "true",
        "set OPENSLATE_RUN_CADDY_ACCEPTANCE=true to run disposable Docker acceptance",
    )
    def test_private_health_probe_routes_nonlocalhost_gateway_on_an_internal_network(self) -> None:
        if shutil.which("docker") is None:
            self.skipTest("Docker is unavailable")
        image = subprocess.run(
            ["docker", "image", "inspect", CADDY_IMAGE],
            check=False,
            capture_output=True,
            text=True,
        )
        if image.returncode != 0:
            self.skipTest("the pinned Caddy image is unavailable")

        run_id = secrets.token_hex(16)
        network = f"openslate-caddy-health-network-{run_id}"
        gateway = f"openslate-caddy-health-gateway-{run_id}"
        upstream = f"openslate-caddy-health-upstream-{run_id}"
        try:
            with tempfile.TemporaryDirectory() as directory:
                gateway_config = Path(directory) / "gateway.Caddyfile"
                gateway_config.write_text(
                    self.render(
                        public_host="portal.example.test",
                        https_port=3448,
                        health_port=3449,
                        backend_port=8080,
                        upstream_host="health-upstream",
                    ),
                    encoding="utf-8",
                )
                gateway_config.chmod(0o644)
                loopback_public_config = Path(directory) / "loopback-public.Caddyfile"
                loopback_public_config.write_text(
                    self.render(
                        public_host="127.0.0.1",
                        https_port=3448,
                        health_port=3449,
                        backend_port=8080,
                        upstream_host="health-upstream",
                    ),
                    encoding="utf-8",
                )
                loopback_public_config.chmod(0o644)
                adapted = subprocess.run(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "--mount",
                        f"type=bind,src={loopback_public_config},dst=/etc/caddy/Caddyfile,readonly",
                        CADDY_IMAGE,
                        "caddy",
                        "adapt",
                        "--config",
                        "/etc/caddy/Caddyfile",
                        "--adapter",
                        "caddyfile",
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(adapted.returncode, 0, adapted.stderr)
                upstream_config = Path(directory) / "upstream.Caddyfile"
                upstream_config.write_text(
                    ":8080 {\n"
                    "    @health path /api/health\n"
                    "    respond @health 200\n"
                    "    respond 404\n"
                    "}\n",
                    encoding="utf-8",
                )
                upstream_config.chmod(0o644)
                created_network = subprocess.run(
                    [
                        "docker",
                        "network",
                        "create",
                        "--internal",
                        "--label",
                        f"openslate.test.run={run_id}",
                        network,
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(created_network.returncode, 0, created_network.stderr)
                started_upstream = subprocess.run(
                    [
                        "docker",
                        "run",
                        "--detach",
                        "--name",
                        upstream,
                        "--label",
                        f"openslate.test.run={run_id}",
                        "--network",
                        network,
                        "--network-alias",
                        "health-upstream",
                        "--mount",
                        f"type=bind,src={upstream_config},dst=/etc/caddy/Caddyfile,readonly",
                        CADDY_IMAGE,
                        "caddy",
                        "run",
                        "--config",
                        "/etc/caddy/Caddyfile",
                        "--adapter",
                        "caddyfile",
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(started_upstream.returncode, 0, started_upstream.stderr)
                launch = subprocess.run(
                    [
                        "docker",
                        "run",
                        "--detach",
                        "--name",
                        gateway,
                        "--label",
                        f"openslate.test.run={run_id}",
                        "--network",
                        network,
                        "--mount",
                        f"type=bind,src={gateway_config},dst=/etc/caddy/Caddyfile,readonly",
                        CADDY_IMAGE,
                        "caddy",
                        "run",
                        "--config",
                        "/etc/caddy/Caddyfile",
                        "--adapter",
                        "caddyfile",
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(launch.returncode, 0, launch.stderr)

                deadline = time.monotonic() + 10
                probe = subprocess.CompletedProcess([], 1)
                while time.monotonic() < deadline:
                    probe = subprocess.run(
                        [
                            "docker",
                            "exec",
                            gateway,
                            "wget",
                            "--quiet",
                            "--spider",
                            "http://127.0.0.1:3449/api/health",
                        ],
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                    if probe.returncode == 0:
                        break
                    time.sleep(0.2)
                self.assertEqual(probe.returncode, 0, probe.stderr)
        finally:
            for container in (gateway, upstream):
                inspect = subprocess.run(
                    [
                        "docker",
                        "inspect",
                        "--format",
                        '{{index .Config.Labels "openslate.test.run"}}',
                        container,
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                if inspect.returncode == 0:
                    self.assertEqual(inspect.stdout.strip(), run_id)
                    subprocess.run(
                        ["docker", "rm", "--force", container],
                        check=False,
                        capture_output=True,
                        text=True,
                    )
            inspect_network = subprocess.run(
                [
                    "docker",
                    "network",
                    "inspect",
                    "--format",
                    '{{index .Labels "openslate.test.run"}}',
                    network,
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            if inspect_network.returncode == 0:
                self.assertEqual(inspect_network.stdout.strip(), run_id)
                subprocess.run(
                    ["docker", "network", "rm", network],
                    check=False,
                    capture_output=True,
                    text=True,
                )


if __name__ == "__main__":
    unittest.main()
