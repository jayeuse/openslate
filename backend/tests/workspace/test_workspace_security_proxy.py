"""Actual strict-test app through the production Caddy template and a distinct peer.

Rerun from backend/: uv run python -m tests.fullstack_runner --backend-batch
--layer integration tests/workspace/test_workspace_security_proxy.py
No development policy, existing account, frontend build or fullstack suite is used.
"""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.caddy_runtime import DisposableCaddy
from tests.fullstack_environment import api_environment
from tests.runner_console import stop_process_group

pytest_plugins = ("tests.auth.provider_account_support",)
pytestmark = pytest.mark.integration
_PROVIDER_KEYS = (
    "SUPABASE_URL",
    "SUPABASE_AUTH_ISSUER",
    "SUPABASE_STORAGE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SESSION_ENCRYPTION_KEY",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_ADMIN_EMAIL",
)


def test_workspace_security_resolves_caddy_peer_and_refuses_forged_lockout(
    provider_account, tmp_path: Path
) -> None:
    email, password, provider_id, local_id, owner = provider_account
    settings = get_settings()
    assert settings.environment == "test"
    assert os.environ["E2E_ALLOW_MUTATIONS"] == "true"
    for family, address, port in (
        (socket.AF_INET, "127.0.0.1", 8008),
        (socket.AF_INET6, "::1", 3448),
        (socket.AF_INET, "127.0.0.1", 3449),
    ):
        with socket.socket(family, socket.SOCK_STREAM) as listener:
            listener.bind((address, port))
    private = tmp_path / "proxy"
    private.mkdir(mode=0o700)
    observation: dict[str, object] = {
        "environment": "test",
        "origin": "https://[::1]:3448",
        "trusted_upstream_peer": "127.0.0.1",
        "controlled_socket_peer": "::1",
        "forged_header": "192.0.2.77",
        "phase": "setup",
    }
    with Session(owner) as db:
        user = db.get(User, local_id)
        profile = db.scalar(select(WorkspaceProfile))
        assert user is not None and profile is not None
        user.supabase_user_id = provider_id
        user.role = "admin"
        original = {
            field: getattr(profile, field)
            for field in (
                "revision",
                "mfa_require_admin",
                "mfa_require_member",
                "mfa_require_guest",
                "ip_allow_list",
                "performed_by",
            )
        }
        profile.mfa_require_admin = profile.mfa_require_member = profile.mfa_require_guest = False
        profile.ip_allow_list = []
        db.commit()
    base_env = {
        name: os.environ[name]
        for name in ("PATH", "HOME", "TMPDIR", "OPENSLATE_ENV_SOURCE")
        if name in os.environ
    }
    environment = api_environment(
        base_env,
        {"DATABASE_URL": settings.database_url},
        {name: os.environ[name] for name in _PROVIDER_KEYS},
        run_id=os.environ["OPENSLATE_FULLSTACK_RUN_ID"],
        database_manifest=Path(os.environ["OPENSLATE_TEST_DATABASE_MANIFEST"]),
        private=private,
        public_origin=str(observation["origin"]),
    )
    api: subprocess.Popen[str] | None = None
    gateway: DisposableCaddy | None = None
    log_path = private / "process.log"
    try:
        with log_path.open("w") as log:
            log_path.chmod(0o600)
            try:
                api = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "uvicorn",
                        "app.main:app",
                        "--host",
                        "127.0.0.1",
                        "--port",
                        "8008",
                        "--no-access-log",
                        "--proxy-headers",
                        "--forwarded-allow-ips",
                        "127.0.0.1",
                    ],
                    cwd=Path(__file__).resolve().parents[2],
                    env=environment,
                    stdout=log,
                    stderr=log,
                    text=True,
                    start_new_session=True,
                )
                gateway = DisposableCaddy(
                    private,
                    os.environ["OPENSLATE_FULLSTACK_RUN_ID"],
                    base_env,
                    log,
                    native_ipv6=True,
                )
                gateway.start()
                observation["config_adapted_and_validated"] = True
                observation["phase"] = "startup"
                with httpx.Client(
                    base_url=str(observation["origin"]),
                    verify=False,
                    trust_env=False,
                    timeout=5,
                    headers={"Origin": str(observation["origin"])},
                ) as client:
                    deadline = time.monotonic() + 60
                    while True:
                        if api.poll() is not None or gateway.poll() is not None:
                            raise RuntimeError("Owned proxy proof process exited during startup")
                        try:
                            if client.get("/api/ready").status_code == 200:
                                break
                        except httpx.HTTPError:
                            pass
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Owned proxy proof readiness deadline exceeded")
                        time.sleep(0.1)
                    observation["phase"] = "authenticated"
                    login = client.post(
                        "/api/auth/login", json={"email": email, "password": password}
                    )
                    assert login.status_code == 200
                    csrf = client.cookies.get("openslate_csrf")
                    assert csrf
                    client.headers["X-CSRF-Token"] = csrf
                    response = client.get(
                        "/api/workspace/security/caller-ip",
                        headers={"X-Forwarded-For": "192.0.2.77"},
                    )
                    observation["caller_status"] = response.status_code
                    assert response.status_code == 200
                    observation["resolved_address"] = response.json()["address"]
                    assert response.json() == {"address": "::1"}
                    assert response.headers["cache-control"] == "no-store"
                    before = client.get("/api/workspace/security").json()
                    accepted = client.patch(
                        "/api/workspace/security",
                        json={"revision": before["revision"], "ip_allow_list": ["::1"]},
                    )
                    observation["actual_peer_patch_status"] = accepted.status_code
                    assert accepted.status_code == 200
                    saved = accepted.json()
                    assert saved["ip_allow_list"] == ["::1/128"]
                    refused = client.patch(
                        "/api/workspace/security",
                        json={
                            "revision": saved["revision"],
                            "ip_allow_list": ["192.0.2.77"],
                        },
                        headers={"X-Forwarded-For": "192.0.2.77"},
                    )
                    observation["forged_only_patch_status"] = refused.status_code
                    assert refused.status_code == 409
                    assert refused.json()["detail"]["code"] == "ip_lockout"
                    assert client.get("/api/workspace/security").json() == saved
                    observation["authoritative_policy_revision_unchanged"] = True
                    observation["phase"] = "passed"
            finally:
                if gateway is not None:
                    gateway.stop()
                if api is not None:
                    stop_process_group(api)
                    observation["api_reaped"] = api.poll() is not None
                observation["caddy_reaped"] = (
                    gateway is None or gateway.process is None or gateway.process.poll() is not None
                )
    finally:
        with Session(owner) as db:
            profile = db.scalar(select(WorkspaceProfile))
            assert profile is not None
            for field, value in original.items():
                setattr(profile, field, value)
            db.commit()
        observation["owned_policy_restored"] = True
        result = private / "observations.json"
        result.write_text(json.dumps(observation, indent=2) + "\n")
        result.chmod(0o600)
