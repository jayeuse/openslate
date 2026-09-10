"""Real, isolated ClamAV generation and worker for disposable release tests.

The engine has no published ports or egress. SDK probes join only its internal
network; the worker also joins a task-owned network to reach disposable services.
"""

import json
import re
import shutil
import subprocess
import sys
import time
import tomllib
from datetime import UTC, datetime
from hashlib import file_digest
from io import BytesIO
from pathlib import Path
from typing import IO
from urllib.parse import urlsplit
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile

from pypdf import PdfWriter

from app.core.config import Settings

BASE_IMAGE_DIGEST = "sha256:aeac907bb9445b12c1dd76f9283415272d8dcd596d402245ed13729d7181bb8a"
MANIFEST = "/run/scanner-manifest.json"


class DisposableScanner:
    def __init__(self, root: Path, private: Path, run_id: str, env: dict[str, str], log: IO[str]):
        if re.fullmatch(r"[a-f0-9]{32}", run_id) is None:
            raise ValueError("Invalid scanner test namespace")
        self.root, self.private, self.run_id = root, private, run_id
        self.env, self.log = env, log
        self.image = f"openslate-clamav-e2e:{run_id}"
        self.backend_image = f"openslate-scan-worker-e2e:{run_id}"
        self.container = f"openslate-clamav-e2e-{run_id}"
        self.updater = f"openslate-freshclam-e2e-{run_id}"
        self.worker = f"openslate-scan-worker-e2e-{run_id}"
        self.network = f"openslate-clamav-e2e-{run_id}"
        self.egress = f"openslate-worker-e2e-{run_id}"
        self.definitions = private / "scanner-definitions"
        self.manifest = private / "scanner-manifest.json"
        self.containers: set[str] = set()
        self.networks: list[str] = []
        self.images: list[str] = []
        self.observations: dict[str, object] = {}

    def _run(self, arguments: list[str], *, capture: bool = False, timeout: int = 600):
        return subprocess.run(
            ["docker", *arguments],
            cwd=self.root,
            env=self.env,
            stdout=subprocess.PIPE if capture else self.log,
            stderr=self.log,
            text=True,
            check=True,
            timeout=timeout,
        )

    def _security(self, *, engine: bool) -> list[str]:
        flags = ["--platform", "linux/amd64", "--pull", "never", "--read-only"]
        flags += ["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--no-healthcheck"]
        flags += ["--pids-limit", "64", "--env", "TZ=UTC", "--env", "LC_ALL=C"]
        flags += ["--user", "100:101" if engine else "10001:10001"]
        flags += ["--memory", "4g" if engine else "512m", "--cpus", "2" if engine else "1"]
        owner = "uid=100,gid=101" if engine else "uid=10001,gid=10001"
        flags += ["--tmpfs", f"/tmp:rw,noexec,nosuid,size=128m,{owner},mode=1770"]
        return flags + ["--label", f"openslate.test.run={self.run_id}"]

    def _remove_container(self, name: str) -> None:
        present = subprocess.run(
            ["docker", "container", "inspect", name],
            env=self.env,
            stdout=subprocess.DEVNULL,
            stderr=self.log,
            timeout=15,
        )
        if present.returncode == 0:
            self._run(["rm", "--force", name], timeout=30)
        self.containers.discard(name)

    def _sidecar(self, arguments: list[str], content: bytes = b"", *, manifest: bool = False):
        name = f"openslate-scanner-probe-{self.run_id}-{uuid4().hex[:8]}"
        mounts = (
            ["--mount", f"type=bind,src={self.manifest},dst={MANIFEST},readonly"]
            if manifest
            else []
        )
        self.containers.add(name)
        try:
            result = subprocess.run(
                [
                    "docker",
                    "run",
                    "--interactive",
                    "--name",
                    name,
                    *self._security(engine=False),
                    "--network",
                    self.network,
                    *mounts,
                    "--entrypoint",
                    "/app/.venv/bin/python",
                    self.backend_image,
                    *arguments,
                ],
                cwd=self.root,
                env=self.env,
                input=content,
                stdout=subprocess.PIPE,
                stderr=self.log,
                check=True,
                timeout=75,
            )
            return json.loads(result.stdout)
        finally:
            self._remove_container(name)

    def _build(self) -> None:
        # Keep the installed builder available without importing personal Docker credentials.
        plugin = Path.home() / ".docker/cli-plugins/docker-buildx"
        destination = Path(self.env["HOME"]) / ".docker/cli-plugins/docker-buildx"
        if plugin.is_file() and not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.symlink_to(plugin.resolve())
        context = self.private / "scanner-build"
        (context / "infra/clamav").mkdir(parents=True, exist_ok=True)
        (context / "infra/docker").mkdir(exist_ok=True)
        for name in ("clamd.conf", "freshclam.conf", "serve.sh"):
            shutil.copyfile(self.root / "infra/clamav" / name, context / "infra/clamav" / name)
        for name in ("clamav.Dockerfile", "backend.Dockerfile"):
            shutil.copyfile(self.root / "infra/docker" / name, context / "infra/docker" / name)
        if BASE_IMAGE_DIGEST not in (context / "infra/docker/clamav.Dockerfile").read_text():
            raise RuntimeError("Scanner base image changed; review the release fixture")
        (context / "backend").mkdir(exist_ok=True)
        for name in ("pyproject.toml", "uv.lock"):
            shutil.copyfile(self.root / "backend" / name, context / "backend" / name)
        shutil.copytree(
            self.root / "backend/app",
            context / "backend/app",
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        for image, dockerfile in (
            (self.image, "clamav.Dockerfile"),
            (self.backend_image, "backend.Dockerfile"),
        ):
            self.images.append(image)
            self._run(
                [
                    "build",
                    "--platform",
                    "linux/amd64",
                    "--file",
                    str(context / "infra/docker" / dockerfile),
                    "--tag",
                    image,
                    str(context),
                ]
            )

    def _hashes(self) -> dict[str, str]:
        hashes = {}
        for path in sorted(self.definitions.iterdir()):
            if path.name in {
                "main.cvd",
                "main.cld",
                "daily.cvd",
                "daily.cld",
                "bytecode.cvd",
                "bytecode.cld",
            }:
                with path.open("rb") as source:
                    hashes[path.name] = file_digest(source, "sha256").hexdigest()
        if (
            len(set(hashes) & {"main.cvd", "main.cld"}) != 1
            or len(set(hashes) & {"daily.cvd", "daily.cld"}) != 1
        ):
            raise RuntimeError("FreshClam did not produce a complete official generation")
        return hashes

    def _runtime_posture(self) -> None:
        engine = json.loads(
            self._run(["inspect", self.container], capture=True, timeout=10).stdout
        )[0]
        network = json.loads(
            self._run(["network", "inspect", self.network], capture=True, timeout=10).stdout
        )[0]
        host = engine["HostConfig"]
        mounts = [mount for mount in engine["Mounts"] if mount["Destination"] == "/var/lib/clamav"]
        names = {entry.split("=", 1)[0] for entry in engine["Config"]["Env"]}
        if (
            engine["Config"]["User"] != "100:101"
            or not host["ReadonlyRootfs"]
            or host["CapDrop"] != ["ALL"]
            or "no-new-privileges" not in host["SecurityOpt"]
            or host["Memory"] != 4 * 1024**3
            or host["NanoCpus"] != 2_000_000_000
            or host["PidsLimit"] != 64
            or "size=128m" not in host["Tmpfs"].get("/tmp", "")
            or not network["Internal"]
            or set(engine["NetworkSettings"]["Networks"]) != {self.network}
            or len(mounts) != 1
            or mounts[0]["RW"]
            or host.get("PortBindings")
            or host["LogConfig"]["Type"] != "none"
            or any(
                name.startswith(("DATABASE_", "MIGRATION_", "SUPABASE_", "SECURITY_EVENT_"))
                for name in names
            )
        ):
            raise RuntimeError("Scanner runtime does not match its isolation contract")

    def _sdk_acceptance(self) -> None:
        pdf = PdfWriter()
        pdf.add_blank_page(width=72, height=72)
        clean = BytesIO()
        pdf.write(clean)
        # Harmless standardized test signature embedded in a valid PDF comment.
        eicar = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
        infected = clean.getvalue().replace(b"%%EOF", b"% " + eicar + b"\n%%EOF")
        pdf.add_attachment("eicar.com", eicar)
        attached = BytesIO()
        pdf.write(attached)
        pdf.encrypt(uuid4().hex)
        encrypted = BytesIO()
        pdf.write(encrypted)
        archive = BytesIO()
        with ZipFile(archive, "w", compression=ZIP_DEFLATED) as bundle:
            for index in range(2049):
                bundle.writestr(f"item-{index}.txt", "bounded inspection fixture")
        sdk_code = "\n".join(
            [
                "import json,sys; from dataclasses import asdict; from hashlib import sha256",
                "from uuid import uuid4; from app.systems.files.clamav import ClamAVScanner",
                "from app.systems.files.providers import "
                "ProviderUnavailable, ScannerPolicyRejected, ScannerExecutionUncertain",
                "content=sys.stdin.buffer.read(26214401)",
                "try:",
                " result=asdict(ClamAVScanner(sys.argv[1],3310,sys.argv[2]).scan(content, "
                "digest=sha256(content).hexdigest(),operation_id=uuid4()))",
                "except ScannerExecutionUncertain: result={'error':'uncertain'}",
                "except ScannerPolicyRejected: result={'error':'policy'}",
                "except ProviderUnavailable: result={'error':'unavailable'}",
                "print(json.dumps(result))",
            ]
        )
        command = ["-c", sdk_code, self.container, MANIFEST]
        failures = []
        for label, content, expected in (
            ("clean_pdf", clean.getvalue(), {"outcome": "clean"}),
            ("eicar_pdf_comment", infected, None),
            ("eicar_pdf_attachment", attached.getvalue(), {"outcome": "infected"}),
            ("encrypted_pdf", encrypted.getvalue(), {"error": "policy"}),
            ("archive_file_limit", archive.getvalue(), {"error": "policy"}),
        ):
            started = time.monotonic()
            outcome = self._sidecar(command, content, manifest=True)
            self.observations[label] = {
                "actual": outcome.get("error", outcome.get("outcome")),
                "expected": next(iter(expected.values())) if expected else "observation only",
                "elapsed_seconds": round(time.monotonic() - started, 2),
            }
            if outcome.get("error") == "uncertain":
                raise RuntimeError(
                    f"Scanner execution is uncertain at {label}; discard this engine"
                )
            if expected and any(outcome.get(key) != value for key, value in expected.items()):
                failures.append(label)
        if failures:
            raise RuntimeError("Real scanner component acceptance failed: " + ", ".join(failures))

    def start(self) -> None:
        config = tomllib.loads((self.private / "supabase/config.toml").read_text())
        if (
            config["project_id"] != f"p5-{self.run_id}"
            or config["api"]["port"] != 55321
            or config["db"]["port"] != 55322
        ):
            raise RuntimeError("Scanner requires the exact disposable service tuple")
        self._build()
        self.definitions.mkdir(mode=0o777, exist_ok=True)
        # Public signatures live inside the run's 0700 private directory. Only
        # FreshClam's one explicit mount is writable, before serving starts.
        self.definitions.chmod(0o777)
        self.containers.add(self.updater)
        self._run(
            [
                "run",
                "--name",
                self.updater,
                *self._security(engine=True),
                "--mount",
                f"type=bind,src={self.definitions},dst=/var/lib/clamav",
                "--entrypoint",
                "/usr/bin/freshclam",
                self.image,
                "--config-file=/etc/clamav/openslate-freshclam.conf",
            ]
        )
        self._remove_container(self.updater)
        hashes = self._hashes()
        self.networks.append(self.network)
        self._run(
            [
                "network",
                "create",
                "--internal",
                "--label",
                f"openslate.test.run={self.run_id}",
                self.network,
            ],
            timeout=30,
        )
        self.containers.add(self.container)
        self._run(
            [
                "run",
                "--detach",
                "--name",
                self.container,
                "--log-driver",
                "none",
                *self._security(engine=True),
                "--network",
                self.network,
                "--mount",
                f"type=bind,src={self.definitions},dst=/var/lib/clamav,readonly",
                "--env", "FILES_CLAMAV_PORT=3310",
                self.image,
            ],
            timeout=30,
        )
        version_code = (
            "import json,sys; from clamdpy import ClamdNetworkSocket; "
            "from datetime import UTC; "
            "v=ClamdNetworkSocket(host=sys.argv[1],port=3310,timeout=2).version(); "
            "print(json.dumps({'engine_version':v.version,'signature_version':v.signature,"
            "'signature_timestamp':v.signature_date.replace(tzinfo=UTC).isoformat()}))"
        )
        deadline = time.monotonic() + 180
        version = None
        while time.monotonic() < deadline:
            try:
                version = self._sidecar(["-c", version_code, self.container])
                break
            except subprocess.CalledProcessError:
                running = self._run(
                    ["inspect", "--format", "{{.State.Running}}", self.container],
                    capture=True,
                    timeout=10,
                ).stdout.strip()
                if running != "true":
                    raise RuntimeError("ClamAV exited before readiness") from None
                time.sleep(0.5)
        if version is None:
            raise RuntimeError("ClamAV startup deadline exceeded")
        image_id = self._run(
            ["inspect", "--format", "{{.Image}}", self.container], capture=True, timeout=10
        ).stdout.strip()
        self.manifest.unlink(missing_ok=True)
        self.manifest.write_text(
            json.dumps(
                {
                    **version,
                    "image_digest": image_id,
                    "generation": self.run_id,
                    "checked_at": datetime.now(UTC).isoformat(),
                    "signature_hashes": hashes,
                }
            )
        )
        # Metadata contains no credentials; the containing host directory is private.
        self.manifest.chmod(0o444)
        self._runtime_posture()
        self.observations.update(
            {
                **version,
                "image_digest": image_id,
                "base_image_digest": BASE_IMAGE_DIGEST,
                "official_signatures": sorted(hashes),
                "signature_age_seconds": round(
                    (
                        datetime.now(UTC) - datetime.fromisoformat(version["signature_timestamp"])
                    ).total_seconds()
                ),
                "real_engine": True,
                "serving_network_internal": True,
                "published_engine_ports": [],
                "memory_bytes": 4 * 1024**3,
                "cpus": 2,
                "pids": 64,
                "tmpfs_bytes": 128 * 1024**2,
            }
        )
        self._sdk_acceptance()
        if self._hashes() != hashes:
            raise RuntimeError("Serving signature generation changed during acceptance")
        self.observations["signature_hashes_unchanged"] = True

    def start_worker(
        self, application_env: dict[str, str], *, acknowledge_engine_replacement: bool = False
    ) -> None:
        target = urlsplit(application_env["DATABASE_URL"])
        if (
            target.hostname != "127.0.0.1"
            or target.port != 55322
            or target.username != "openslate_runtime"
            or application_env["SUPABASE_URL"] != "http://127.0.0.1:55321"
        ):
            raise RuntimeError("Worker requires exact disposable runtime credentials")
        worker_env = {
            key: application_env[key]
            for key in (name.upper() for name in Settings.model_fields)
        }
        worker_env["DATABASE_URL"] = worker_env["DATABASE_URL"].replace(
            "@127.0.0.1:55322/", "@host.docker.internal:55322/"
        )
        worker_env.update(
            OPENSLATE_ENV_SOURCE="process",
            SUPABASE_URL="http://host.docker.internal:55321",
            LOG_DIR="/tmp/logs",
            FILES_CLAMAV_HOST=self.container,
            FILES_CLAMAV_PORT="3310",
            FILES_CLAMAV_MANIFEST_PATH=MANIFEST,
        )
        credentials = self.private / "scanner-worker.env"
        credentials.write_text(
            "\n".join(f"{key}={value}" for key, value in worker_env.items()) + "\n"
        )
        credentials.chmod(0o600)
        if self.egress not in self.networks:
            self.networks.append(self.egress)
            self._run(
                ["network", "create", "--label", f"openslate.test.run={self.run_id}", self.egress]
            )
        arguments = ["-m", "app.systems.files.worker"]
        if acknowledge_engine_replacement:
            arguments.append("--acknowledge-engine-replacement")
        self.containers.add(self.worker)
        self._run(
            [
                "create",
                "--name",
                self.worker,
                *self._security(engine=False),
                "--network",
                self.egress,
                *(
                    ["--add-host", "host.docker.internal:host-gateway"]
                    if sys.platform == "linux"
                    else []
                ),
                "--env-file",
                str(credentials),
                "--mount",
                f"type=bind,src={self.manifest},dst={MANIFEST},readonly",
                "--entrypoint",
                "/app/.venv/bin/python",
                self.backend_image,
                *arguments,
            ]
        )
        self._run(["network", "connect", self.network, self.worker])
        self._run(["start", self.worker])
        self.observations["containerized_worker"] = True

    def stop(self) -> None:
        failures = []
        # Stop the worker before its engine; then no application work can survive
        # deletion of this generation and its private configuration.
        ordered = [
            self.worker,
            *sorted(self.containers - {self.worker, self.container}),
            self.container,
        ]
        for name in ordered:
            if name not in self.containers:
                continue
            try:
                if name != self.container:
                    try:
                        self._run(["logs", name], timeout=10)
                    except subprocess.SubprocessError:
                        pass
                self._remove_container(name)
            except (OSError, subprocess.SubprocessError):
                failures.append(name)
        for kind, names in (("network", reversed(self.networks)), ("image", reversed(self.images))):
            for name in names:
                try:
                    self._run([kind, "rm", name], timeout=30)
                except (OSError, subprocess.SubprocessError):
                    failures.append(name)
        if failures:
            raise RuntimeError("Disposable scanner cleanup failed")
