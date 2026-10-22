"""Cookie-authenticated event stream through the production Caddy template.

A same-origin browser GET sends Sec-Fetch-Site but no Origin. The gateway must pass
that request through without inventing an Origin header.

Rerun from backend/: uv run python -m tests.fullstack_runner --backend-batch
--layer integration tests/events/test_sse_caddy_proxy.py
"""

import os
import socket
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.systems.access.users.models import Membership, User
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.caddy_runtime import DisposableCaddy
from tests.fullstack_environment import api_environment
from tests.fullstack_runner import wait_for
from tests.runner_console import stop_process_group

pytest_plugins = ("tests.auth.provider_account_support",)
pytestmark = pytest.mark.integration
_ORIGIN = "https://[::1]:3448"
_PROVIDER_KEYS = (
    "SUPABASE_URL",
    "REALTIME_PUBLISH_URL",
    "SUPABASE_AUTH_ISSUER",
    "SUPABASE_STORAGE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SESSION_ENCRYPTION_KEY",
    "REALTIME_TOKEN_SIGNING_KEY",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_ADMIN_EMAIL",
)


def test_same_origin_event_stream_without_origin_opens_through_caddy(
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
    with Session(owner) as db:
        user = db.get(User, local_id)
        membership = db.scalars(select(Membership).where(Membership.user_id == local_id)).one()
        org_id = membership.org_id
        profile = db.get(WorkspaceProfile, org_id)
        assert user is not None and profile is not None
        user.supabase_user_id = provider_id
        # The stream re-checks the organization's MFA and network rules on open.
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
        public_origin=_ORIGIN,
    )
    api: subprocess.Popen[str] | None = None
    gateway: DisposableCaddy | None = None
    log_path = private / "process.log"
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
                private, os.environ["OPENSLATE_FULLSTACK_RUN_ID"], base_env, log, native_ipv6=True
            )
            gateway.start()
            wait_for(f"{_ORIGIN}/api/ready", api, verify=False)
            # No client-level Origin: only the login POST carries one, as a browser would.
            with httpx.Client(base_url=_ORIGIN, verify=False, trust_env=False, timeout=5) as client:
                login = client.post(
                    "/api/auth/login",
                    json={"email": email, "password": password},
                    headers={"Origin": _ORIGIN},
                )
                assert login.status_code == 200
                with client.stream(
                    "GET",
                    "/api/events",
                    params={"org": str(org_id)},
                    headers={"Accept": "text/event-stream", "Sec-Fetch-Site": "same-origin"},
                ) as stream:
                    assert "origin" not in stream.request.headers
                    assert stream.status_code == 200
                    assert stream.headers["content-type"].startswith("text/event-stream")
                    assert next(stream.iter_text()).startswith("event: resync")
        finally:
            if gateway is not None:
                gateway.stop()
            if api is not None:
                stop_process_group(api)
