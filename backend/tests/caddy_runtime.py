"""Disposable Caddy gateway support for the full-stack release runner."""

import os
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from typing import IO

ROOT = Path(__file__).resolve().parents[2]
GATEWAY_PORT = 3448
HEALTH_PORT = 3449
CADDY_IMAGE = "caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d"


def render_gateway_config(
    upstream_host: str = "host.docker.internal", listen_address: str = "0.0.0.0"
) -> str:
    """Render the deployed gateway template for this disposable test topology."""
    if upstream_host not in {"127.0.0.1", "host.docker.internal"}:
        raise ValueError("test gateway upstream is not permitted")
    if listen_address not in {"127.0.0.1", "0.0.0.0"}:
        raise ValueError("test gateway listen address is not permitted")
    source = (ROOT / "infra/caddy/Caddyfile.template").read_text(encoding="utf-8")
    replacements = {
        "{{PUBLIC_HOST}}": "localhost",
        "{{LISTEN_ADDRESS}}": listen_address,
        "{{HTTPS_PORT}}": str(GATEWAY_PORT),
        "{{HEALTH_PORT}}": str(HEALTH_PORT),
        "{{BACKEND_PORT}}": "8008",
        "{{FRONTEND_PORT}}": "3008",
        "{{UPSTREAM_HOST}}": upstream_host,
        "{{TLS_DIRECTIVE}}": "internal",
    }
    for placeholder, value in replacements.items():
        source = source.replace(placeholder, value)
    if "{{" in source or source.count(f"reverse_proxy {upstream_host}:") != 4:
        raise RuntimeError("gateway template no longer matches the disposable test contract")
    return source


class DisposableCaddy:
    """Own a loopback-only Caddy gateway for one full-stack run."""

    def __init__(self, private: Path, run_id: str, env: dict[str, str], log: IO[str]) -> None:
        self.private = private
        self.run_id = run_id
        self.env = env
        self.log = log
        self.container = f"openslate-caddy-e2e-{run_id}"
        self.image = f"openslate-caddy-e2e-{run_id}:local"
        self.config = private / "Caddyfile"
        self.dockerfile = private / "caddy-image.Dockerfile"
        self.process: subprocess.Popen[str] | None = None
        self.native_binary = shutil.which("caddy")

    def _run(
        self, arguments: list[str], *, capture: bool = False
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["docker", *arguments],
            env=self.env,
            stdout=subprocess.PIPE if capture else self.log,
            stderr=self.log,
            text=True,
            check=True,
            timeout=60,
        )

    def start(self) -> None:
        native_binary = self.native_binary
        native = native_binary is not None
        linux_host_network = not native and sys.platform.startswith("linux")
        loopback_gateway = native or linux_host_network
        self.config.write_text(
            render_gateway_config(
                "127.0.0.1" if loopback_gateway else "host.docker.internal",
                "127.0.0.1" if loopback_gateway else "0.0.0.0",
            ),
            encoding="utf-8",
        )
        # The generated Caddyfile contains no credentials and must be readable
        # by the unprivileged Docker image user on a native Linux bind mount.
        self.config.chmod(0o644)
        if native:
            assert native_binary is not None
            subprocess.run(
                [
                    native_binary,
                    "validate",
                    "--config",
                    str(self.config),
                    "--adapter",
                    "caddyfile",
                ],
                env=self.env,
                stdout=self.log,
                stderr=self.log,
                check=True,
                timeout=30,
            )
            self.process = subprocess.Popen(
                [native_binary, "run", "--config", str(self.config), "--adapter", "caddyfile"],
                env=self.env,
                stdout=self.log,
                stderr=self.log,
                text=True,
                start_new_session=True,
            )
            return
        self.dockerfile.write_text(
            "\n".join(
                (
                    f"FROM {CADDY_IMAGE}",
                    "RUN setcap -r /usr/bin/caddy",
                    "USER 1000:1000",
                    "",
                )
            ),
            encoding="utf-8",
        )
        self.dockerfile.chmod(0o600)
        self._run(["pull", CADDY_IMAGE])
        network_arguments = (
            ["--network", "host"]
            if linux_host_network
            else [
                "--add-host",
                "host.docker.internal:host-gateway",
                "--publish",
                f"127.0.0.1:{GATEWAY_PORT}:{GATEWAY_PORT}/tcp",
            ]
        )
        self._run(
            [
                "build",
                "--pull=false",
                "--label",
                f"openslate.test.run={self.run_id}",
                "--tag",
                self.image,
                "--file",
                str(self.dockerfile),
                str(self.private),
            ]
        )
        self._run(
            [
                "run",
                "--detach",
                "--pull=never",
                "--name",
                self.container,
                "--label",
                f"openslate.test.run={self.run_id}",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--pids-limit",
                "64",
                "--memory",
                "128m",
                "--cpus",
                "1",
                "--tmpfs",
                "/config:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=700",
                "--tmpfs",
                "/data:rw,noexec,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=700",
                *network_arguments,
                "--mount",
                f"type=bind,src={self.config},dst=/etc/caddy/Caddyfile,readonly",
                self.image,
                "caddy",
                "run",
                "--config",
                "/etc/caddy/Caddyfile",
                "--adapter",
                "caddyfile",
            ]
        )

    def poll(self) -> int | None:
        if self.process is not None:
            return self.process.poll()
        try:
            state = self._run(
                ["inspect", "--format", "{{.State.Running}}", self.container], capture=True
            ).stdout.strip()
        except subprocess.CalledProcessError:
            return 1
        return None if state == "true" else 1

    def stop(self) -> None:
        if self.native_binary is not None:
            if self.process is not None and self.process.poll() is None:
                try:
                    os.killpg(self.process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait()
            return
        try:
            owner = self._run(
                [
                    "inspect",
                    "--format",
                    '{{index .Config.Labels "openslate.test.run"}}',
                    self.container,
                ],
                capture=True,
            ).stdout.strip()
        except subprocess.CalledProcessError:
            owner = None
        if owner is not None:
            if owner != self.run_id:
                raise RuntimeError("refusing to remove Caddy container without ownership")
            self._run(["rm", "--force", self.container])
        try:
            image_owner = self._run(
                [
                    "image",
                    "inspect",
                    "--format",
                    '{{index .Config.Labels "openslate.test.run"}}',
                    self.image,
                ],
                capture=True,
            ).stdout.strip()
        except subprocess.CalledProcessError:
            return
        if image_owner != self.run_id:
            raise RuntimeError("refusing to remove Caddy image without ownership")
        self._run(["image", "rm", self.image])
