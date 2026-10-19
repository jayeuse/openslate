"""One isolated, runner-owned Supabase stack for database and provider acceptance."""

from __future__ import annotations

import fcntl
import ipaddress
import json
import re
import socket
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from secrets import token_urlsafe
from typing import IO, Any

from app.core.config.disposable_instance import (
    PROVIDER_IMAGES,
    PROVIDER_NETWORKS,
    PROVIDER_VOLUMES,
    DisposableTargetError,
    assert_live_disposable_ownership,
)
from operations.supabase_keys import generate_secrets

ROOT = Path(__file__).resolve().parents[2]
COMPOSE_DIRECTORY = ROOT / "infra" / "supabase"
DB_PORT = 5432
DB_NAME = "postgres"
DB_ALIAS = "db"
# Test networks use their own /24 per stack, outside Docker's default address pools,
# so parallel shards do not exhaust them ("all predefined address pools ... subnetted").
TEST_NETWORK_PREFIX = "10.199"
NETWORK_LOCK = Path(tempfile.gettempdir()) / "openslate-e2e-networks.lock"
# A stack without the runner API's template port gets TEMPLATE_PORT_BASE + its network
# block: unique per live stack, below the ephemeral ranges (Linux 32768+, macOS 49152+)
# and the Kubernetes NodePort range (30000-32767).
TEMPLATE_PORT_BASE = 29000
DOCKER_ENV_NAMES = frozenset(
    {
        "PATH",
        "HOME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "APPDATA",
        "LOCALAPPDATA",
        "XDG_CONFIG_HOME",
        "LANG",
        "LC_ALL",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
        "DOCKER_CERT_PATH",
        "DOCKER_TLS_VERIFY",
        "DOCKER_API_VERSION",
        "SSL_CERT_FILE",
    }
)


def provider_network_name(run_id: str) -> str:
    return f"openslate-e2e-{run_id}_provider"


def _available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


@contextmanager
def _network_allocation() -> Iterator[None]:
    """Serialize test network allocation across concurrent runner processes."""
    with NETWORK_LOCK.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


class DisposablePostgres:
    """Preserve the runner API while owning the full pinned Supabase provider stack."""

    def __init__(
        self,
        private: Path,
        run_id: str,
        env: dict[str, str],
        log: IO[str],
        *,
        template_port: int | None = None,
    ) -> None:
        if re.fullmatch(r"[a-f0-9]{32}", run_id) is None:
            raise ValueError("Invalid disposable Supabase run identity")
        self.private, self.run_id, self.log = private, run_id, log
        self.env = {key: value for key, value in env.items() if key in DOCKER_ENV_NAMES}
        self.project = f"openslate-e2e-{run_id}"
        self.worktree = str(ROOT.resolve())
        self.network = provider_network_name(run_id)
        self.volume = f"{self.project}_supabase-db-data"
        self.container = f"{self.project}-db-1"
        self.keys = generate_secrets()
        self.passwords = {
            "bootstrap": self.keys["POSTGRES_PASSWORD"],
            "owner": token_urlsafe(32),
            "runtime": token_urlsafe(32),
        }
        self.port: int | None = None
        self.api_port: int | None = None
        self.publisher_port: int | None = None
        self.mail_port: int | None = None
        # Auth fetches email templates from a host listener: the runner API's fixed port
        # when one serves them, otherwise a port derived from this stack's network block.
        self.fixed_template_port = template_port
        self.template_port: int | None = None
        self.env_file = private / "supabase.env"
        self.overlay_file = private / "supabase.test.yaml"
        self.network_block: int | None = None

    def _run(
        self, arguments: list[str], *, capture: bool = False, timeout: int = 60
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["docker", *arguments],
            cwd=ROOT,
            env=self.env,
            stdout=subprocess.PIPE if capture else self.log,
            stderr=self.log,
            text=True,
            check=True,
            timeout=timeout,
        )

    def _compose(
        self, arguments: list[str], *, capture: bool = False, timeout: int = 60
    ) -> subprocess.CompletedProcess[str]:
        # The release runner gives Docker a private HOME; retain its installed
        # Compose plugin without copying Docker's credential configuration.
        source = Path.home() / ".docker/cli-plugins/docker-compose"
        private_home = self.env.get("HOME")
        if private_home is not None and source.is_file():
            destination = Path(private_home) / ".docker/cli-plugins/docker-compose"
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.exists() or destination.is_symlink():
                if destination.resolve() != source.resolve():
                    raise RuntimeError("Disposable Docker Compose plugin path is untrusted")
            else:
                destination.symlink_to(source.resolve())
        return self._run(
            [
                "compose",
                "--project-directory",
                str(COMPOSE_DIRECTORY),
                "--project-name",
                self.project,
                "--env-file",
                str(self.env_file),
                "-f",
                str(COMPOSE_DIRECTORY / "compose.yaml"),
                "-f",
                str(COMPOSE_DIRECTORY / "compose.dev.yaml"),
                "-f",
                str(self.overlay_file),
                *arguments,
            ],
            capture=capture,
            timeout=timeout,
        )

    def _write_inputs(self) -> None:
        if self.port is None or self.api_port is None or self.mail_port is None:
            raise RuntimeError("Disposable Supabase ports are unavailable")
        api_url = f"http://127.0.0.1:{self.api_port}"
        values = {
            **self.keys,
            "OPENSLATE_INSTANCE_ID": self.project,
            # Exercise expiry and real provider rotation within the backend gate. Refresh
            # reuses an access token with more than 30 s left (provider_sessions.py), and
            # fresh-token refresh tests must keep that path, so stay well above 30 s.
            "JWT_EXPIRY": "45",
            "SUPABASE_DB_PORT": str(self.port),
            "SUPABASE_API_PORT": str(self.api_port),
            "SUPABASE_REALTIME_PUBLISH_PORT": str(self.publisher_port),
            "SUPABASE_MAIL_PORT": str(self.mail_port),
            "API_EXTERNAL_URL": f"{api_url}/auth/v1",
            "SUPABASE_PUBLIC_URL": api_url,
            "SITE_URL": "https://localhost:3448",
            "AUTH_TEMPLATE_BASE_URL": (
                f"http://host.docker.internal:{self.template_port}/api/auth/email-templates"
            ),
            "SMTP_ADMIN_EMAIL": "noreply@openslate.test",
            "SMTP_HOST": "mailpit",
            "SMTP_PORT": "1025",
            "SMTP_USER": "",
            "SMTP_PASS": "",
            "DASHBOARD_USERNAME": "openslate-e2e",
        }
        lines = []
        for name, value in values.items():
            if any(character in value for character in ("\n", "\r", "\x00")):
                raise RuntimeError("Disposable Supabase secret contains an unsupported character")
            escaped = value.replace("\\", "\\\\").replace('"', '\\"')
            lines.append(f'{name}="{escaped}"')
        self.env_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.env_file.chmod(0o600)
        labels = {
            "openslate.test.run": self.run_id,
            "openslate.test.worktree": self.worktree,
        }
        label_lines = "\n".join(
            f"      {key}: {json.dumps(value)}" for key, value in labels.items()
        )
        overlay = ["services:"]
        for service in PROVIDER_IMAGES:
            overlay.extend([f"  {service}:", "    labels:", label_lines])
            if service == "db":
                # A disposable test cluster needs no crash durability. Parallel shards
                # otherwise serialize on fsync through Docker Desktop's virtual disk.
                overlay.extend(
                    f"    {line}"
                    for line in (
                        "command:",
                        "  - postgres",
                        "  - -c",
                        "  - config_file=/etc/postgresql/postgresql.conf",
                        "  - -c",
                        "  - cluster_name=${OPENSLATE_INSTANCE_ID}",
                        "  - -c",
                        "  - log_min_messages=fatal",
                        "  - -c",
                        "  - fsync=off",
                        "  - -c",
                        "  - synchronous_commit=off",
                        "  - -c",
                        "  - full_page_writes=off",
                    )
                )
        overlay.append("volumes:")
        for volume in PROVIDER_VOLUMES:
            overlay.extend([f"  {volume}:", "    labels:", label_lines])
        overlay.append("networks:")
        if self.network_block is None:
            raise RuntimeError("Disposable Supabase network block is unassigned")
        for index, network in enumerate(sorted(PROVIDER_NETWORKS)):
            subnet = f"{TEST_NETWORK_PREFIX}.{self.network_block}.{index * 32}/27"
            overlay.extend(
                [
                    f"  {network}:",
                    "    labels:",
                    label_lines,
                    "    ipam:",
                    "      config:",
                    f"        - subnet: {subnet}",
                ]
            )
        self.overlay_file.write_text("\n".join(overlay) + "\n", encoding="utf-8")
        self.overlay_file.chmod(0o600)

    def _used_subnets(self) -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
        # Another runner may remove a network between listing and inspection; retry.
        for _ in range(3):
            ids = self._run(["network", "ls", "-q"], capture=True, timeout=15).stdout.split()
            if not ids:
                return []
            try:
                values = self._run(
                    ["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", *ids],
                    capture=True,
                    timeout=15,
                ).stdout.split()
            except subprocess.CalledProcessError:
                continue
            used = []
            for value in values:
                try:
                    used.append(ipaddress.ip_network(value, strict=False))
                except ValueError:
                    continue
            return used
        raise RuntimeError("Docker networks changed during disposable network allocation")

    def _free_network_block(self) -> int:
        """Return the lowest test /24 that no existing Docker network overlaps."""
        used = self._used_subnets()
        for block in range(1, 255):
            candidate = ipaddress.ip_network(f"{TEST_NETWORK_PREFIX}.{block}.0/24")
            if not any(candidate.overlaps(network) for network in used):
                return block
        raise RuntimeError("No free disposable Supabase network block")

    def start(self) -> None:
        self.port, self.api_port, self.mail_port, self.publisher_port = (
            _available_port(),
            _available_port(),
            _available_port(),
            _available_port(),
        )
        with _network_allocation():
            # Hold the lock only until Compose has created this stack's networks.
            self.network_block = self._free_network_block()
            self.template_port = self.fixed_template_port or (
                TEMPLATE_PORT_BASE + self.network_block
            )
            if (
                len(
                    {
                        self.port,
                        self.api_port,
                        self.mail_port,
                        self.template_port,
                        self.publisher_port,
                    }
                )
                != 5
            ):
                raise RuntimeError("Disposable Supabase host ports collided")
            self._write_inputs()
            self._compose(["config", "--quiet"], timeout=30)
            self._compose(["create"], timeout=120)
        try:
            self._compose(["up", "-d", "--wait", "--wait-timeout", "180"], timeout=210)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            # Capture failures before guarded teardown removes their containers.
            # This output stays in the runner's private log, never the console.
            for diagnostic in (["ps", "--all"], ["logs", "--no-color", "--tail", "120"]):
                try:
                    self._compose(diagnostic, timeout=20)
                except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    pass
            raise
        for service, internal, expected in (
            ("db", DB_PORT, self.port),
            ("api-gw", 8000, self.api_port),
            ("api-gw", 8001, self.publisher_port),
            ("mailpit", 8025, self.mail_port),
        ):
            mapping = self._compose(["port", service, str(internal)], capture=True, timeout=15)
            if mapping.stdout.strip() != f"127.0.0.1:{expected}":
                raise RuntimeError("Disposable Supabase published an unexpected host port")
        ownership = self._ownership()
        self.container = self._inspect_json(["inspect", ownership["service_ids"]["db"]])[0][
            "Name"
        ].removeprefix("/")
        self.assert_cluster_identity()

    def urls(self) -> dict[str, str]:
        if self.port is None:
            raise RuntimeError("Disposable Supabase has no verified database port")
        host = f"127.0.0.1:{self.port}/{DB_NAME}"
        return {
            "DATABASE_BOOTSTRAP_URL": f"postgresql+psycopg://supabase_admin:{self.passwords['bootstrap']}@{host}",
            "MIGRATION_DATABASE_URL": f"postgresql+psycopg://openslate_owner:{self.passwords['owner']}@{host}",
            "DATABASE_URL": f"postgresql+psycopg://openslate_runtime:{self.passwords['runtime']}@{host}",
        }

    @property
    def mail_url(self) -> str:
        if self.mail_port is None:
            raise RuntimeError("Disposable Supabase mail endpoint is unavailable")
        return f"http://127.0.0.1:{self.mail_port}"

    def provider_environment(self) -> dict[str, str]:
        if self.api_port is None:
            raise RuntimeError("Disposable Supabase API endpoint is unavailable")
        api_url = f"http://127.0.0.1:{self.api_port}"
        return {
            "SUPABASE_URL": api_url,
            "REALTIME_PUBLISH_URL": f"http://127.0.0.1:{self.publisher_port}/realtime/v1/api/broadcast",
            "SUPABASE_AUTH_ISSUER": f"{api_url}/auth/v1",
            "SUPABASE_STORAGE_URL": f"{api_url}/storage/v1",
            "SUPABASE_PUBLISHABLE_KEY": self.keys["SUPABASE_PUBLISHABLE_KEY"],
            "SUPABASE_SECRET_KEY": self.keys["SUPABASE_SECRET_KEY"],
            "SUPABASE_SESSION_ENCRYPTION_KEY": self.keys["SUPABASE_SESSION_ENCRYPTION_KEY"],
            "REALTIME_TOKEN_SIGNING_KEY": self.keys["REALTIME_TOKEN_SIGNING_KEY"],
            "SMTP_HOST": "mailpit",
            "SMTP_PORT": "1025",
            "SMTP_ADMIN_EMAIL": "noreply@openslate.test",
        }

    def _inspect_json(self, arguments: list[str]) -> list[Any]:
        try:
            output = self._run(arguments, capture=True, timeout=15).stdout
            if arguments[:5] == ["ps", "-a", "-q", "--no-trunc", "--filter"]:
                return output.splitlines()
            value = json.loads(output)
            if (
                not isinstance(value, list)
                or not value
                or not all(isinstance(item, dict) for item in value)
            ):
                raise ValueError
            return value
        except (ValueError, TypeError, json.JSONDecodeError):
            raise RuntimeError("Disposable Supabase ownership inspection failed") from None

    def _ownership(self) -> dict[str, Any]:
        if self.port is None or self.api_port is None or self.mail_port is None:
            raise RuntimeError("Disposable Supabase endpoints are unavailable")
        services: dict[str, str] = {}
        for service in PROVIDER_IMAGES:
            result = self._compose(["ps", "--all", "-q", service], capture=True, timeout=15)
            ids = result.stdout.splitlines()
            if len(ids) != 1 or re.fullmatch(r"[a-f0-9]{12,64}", ids[0]) is None:
                raise RuntimeError("Disposable Supabase service ownership is incomplete")
            services[service] = ids[0]
        networks = {
            name: self._inspect_json(["network", "inspect", f"{self.project}_{name}"])[0]["Id"]
            for name in PROVIDER_NETWORKS
        }
        ownership: dict[str, Any] = {
            "project": self.project,
            "worktree": self.worktree,
            "compose_directory": str(COMPOSE_DIRECTORY),
            "service_ids": services,
            "network_ids": networks,
            "db_port": self.port,
            "api_port": self.api_port,
            "mail_port": self.mail_port,
            "publisher_port": self.publisher_port,
            "cluster_name": self.project,
        }
        try:
            assert_live_disposable_ownership(ownership, self.run_id, self._inspect_json)
        except DisposableTargetError:
            raise RuntimeError("Disposable Supabase live ownership verification failed") from None
        return ownership

    def write_manifest(self) -> Path:
        from tests.postgres_runtime import container_runtime_database_url

        ownership = self._ownership()
        urls = self.urls()
        api_url = self.provider_environment()["SUPABASE_URL"]
        manifest = self.private / "database.json"
        manifest.write_text(
            json.dumps(
                {
                    "version": 2,
                    "run_id": self.run_id,
                    "urls": list(urls.values()),
                    "container_runtime": {
                        "url": container_runtime_database_url(urls["DATABASE_URL"]),
                        "network": self.network,
                        "alias": DB_ALIAS,
                        "port": DB_PORT,
                    },
                    "provider": {
                        "api_url": api_url,
                        "auth_issuer": f"{api_url}/auth/v1",
                        "storage_url": f"{api_url}/storage/v1",
                        "mail_url": self.mail_url,
                        "publish_url": self.provider_environment()["REALTIME_PUBLISH_URL"],
                    },
                    "ownership": ownership,
                }
            ),
            encoding="utf-8",
        )
        manifest.chmod(0o600)
        return manifest

    def assert_cluster_identity(self) -> None:
        result = self._run(
            [
                "exec",
                self.container,
                "psql",
                "-U",
                "postgres",
                "-d",
                DB_NAME,
                "-At",
                "-c",
                "SELECT current_database(), current_user, current_setting('cluster_name')",
            ],
            capture=True,
            timeout=15,
        )
        if result.stdout.strip() != f"{DB_NAME}|postgres|{self.project}":
            raise RuntimeError("Disposable Supabase cluster identity verification failed")

    def stop(self) -> None:
        """Inspect every resource before removing only this run's containers and volumes."""
        labels = {"openslate.test.run": self.run_id, "openslate.test.worktree": self.worktree}
        result = self._run(
            [
                "ps",
                "-a",
                "-q",
                "--no-trunc",
                "--filter",
                f"label=com.docker.compose.project={self.project}",
            ],
            capture=True,
            timeout=15,
        )
        containers = result.stdout.splitlines()
        for identifier in containers:
            inspected = self._inspect_json(["inspect", identifier])[0]
            config = inspected.get("Config", {})
            actual_labels = config.get("Labels", {})
            service = actual_labels.get("com.docker.compose.service")
            if (
                inspected.get("Id") != identifier
                or service not in PROVIDER_IMAGES
                or config.get("Image") != PROVIDER_IMAGES[service]
                or actual_labels.get("com.docker.compose.project") != self.project
                or actual_labels.get("com.docker.compose.project.working_dir")
                != str(COMPOSE_DIRECTORY)
                or any(actual_labels.get(key) != value for key, value in labels.items())
            ):
                raise RuntimeError("Refusing to remove an unowned Supabase container")
        volumes = []
        for name in PROVIDER_VOLUMES:
            full_name = f"{self.project}_{name}"
            try:
                volume = self._inspect_json(["volume", "inspect", full_name])[0]
            except subprocess.CalledProcessError:
                continue
            actual_labels = volume.get("Labels", {})
            if (
                volume.get("Name") != full_name
                or actual_labels.get("com.docker.compose.project") != self.project
                or actual_labels.get("com.docker.compose.volume") != name
                or any(actual_labels.get(key) != value for key, value in labels.items())
            ):
                raise RuntimeError("Refusing to remove an unowned Supabase volume")
            volumes.append(full_name)
        networks = []
        for name in PROVIDER_NETWORKS:
            full_name = f"{self.project}_{name}"
            try:
                network = self._inspect_json(["network", "inspect", full_name])[0]
            except subprocess.CalledProcessError:
                continue
            actual_labels = network.get("Labels", {})
            if (
                network.get("Name") != full_name
                or actual_labels.get("com.docker.compose.project") != self.project
                or actual_labels.get("com.docker.compose.network") != name
                or any(actual_labels.get(key) != value for key, value in labels.items())
            ):
                raise RuntimeError("Refusing to remove an unowned Supabase network")
            networks.append(full_name)
        for identifier in containers:
            self._run(["rm", "--force", identifier], timeout=30)
        for name in volumes:
            self._run(["volume", "rm", name], timeout=30)
        for name in networks:
            self._run(["network", "rm", name], timeout=30)
