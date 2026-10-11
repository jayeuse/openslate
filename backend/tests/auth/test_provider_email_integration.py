"""Real provider invitation/recovery mail and HTTP completion on an owned stack."""

import html
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from secrets import token_urlsafe
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.main import create_app
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User

pytest_plugins = ("tests.auth.test_provider_auth_integration",)
pytestmark = pytest.mark.integration


class _SignalingServer(uvicorn.Server):
    """Sets `ready` once uvicorn has finished startup and serves the template endpoint."""

    def __init__(self, config: uvicorn.Config) -> None:
        super().__init__(config)
        self.ready = threading.Event()

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets=sockets)
        self.ready.set()


@pytest.fixture
def provider_mail():
    manifest = json.loads(Path(os.environ["OPENSLATE_TEST_DATABASE_MANIFEST"]).read_text())
    auth_id = manifest["ownership"]["service_ids"]["auth"]
    raw = subprocess.check_output(
        ["docker", "inspect", auth_id, "--format", "{{json .Config.Env}}"], text=True
    )
    values = dict(item.split("=", 1) for item in json.loads(raw) if "=" in item)
    captured_only = (
        values.get("GOTRUE_SMTP_HOST") == "mailpit" and values.get("GOTRUE_SMTP_PORT") == "1025"
    )
    assert captured_only, "Email tests require the owned Mailpit SMTP sink"
    bind_host = "127.0.0.1"
    if sys.platform == "linux":
        hosts = subprocess.check_output(["docker", "exec", auth_id, "cat", "/etc/hosts"], text=True)
        bind_host = next(
            line.split()[0]
            for line in hosts.splitlines()
            if "host.docker.internal" in line.split()[1:]
        )
    listener = socket.socket()
    # Back-to-back fixtures leave the previous server's closed connections in TIME_WAIT.
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    # Each runner stack points Auth at its own template port (see supabase_runtime).
    template_port = urlsplit(values["GOTRUE_MAILER_TEMPLATES_INVITE"]).port
    assert template_port is not None, "Auth template URL lacks a port"
    listener.bind((bind_host, template_port))
    listener.listen(128)
    server = _SignalingServer(
        uvicorn.Config(
            create_app(), lifespan="off", log_config=None, access_log=False, log_level="error"
        )
    )
    thread = threading.Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
    thread.start()
    try:
        assert server.ready.wait(5), "Provider template endpoint did not start"
        assert server.started, "Provider template endpoint did not start"
        with httpx.Client(base_url=manifest["provider"]["mail_url"], timeout=5) as mail:
            yield mail
    finally:
        server.should_exit = True
        thread.join(timeout=5)
        listener.close()
        assert not thread.is_alive(), "Provider template endpoint did not stop"


def _email_action(mail, recipient, kind, *, exclude=frozenset()):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        messages = mail.get("/api/v1/messages").json().get("messages", [])
        for message in messages:
            if not any(item.get("Address") == recipient for item in message.get("To", [])):
                continue
            body = mail.get(f"/api/v1/message/{message['ID']}").json()
            for href in re.findall(r'href="([^"]+)"', body.get("HTML", "")):
                link = urlsplit(html.unescape(href))
                fragment = parse_qs(link.fragment)
                if fragment.get("type") == [kind]:
                    assert not link.query, "Email action credentials must stay out of query strings"
                    assert f"{link.scheme}://{link.netloc}" == get_settings().public_origin
                    token = fragment["token_hash"][0]
                    valid = re.fullmatch(r"[0-9a-f]{56}", token) is not None
                    assert valid, "Provider action hash has an unexpected format"
                    if token not in exclude:
                        return token
        time.sleep(0.1)
    pytest.fail("Expected provider action email was not captured")


def test_invitation_and_recovery_use_provider_emails_and_backend_admission(
    provider_account,
    provider_mail,
):
    email, password, provider_id, local_id, owner = provider_account
    settings = get_settings()
    invite_email = f"invite-{uuid4().hex}@example.test"
    with Session(owner) as db:
        user = db.get(User, local_id)
        user.supabase_user_id = provider_id
        user.role = "admin"
        db.commit()
    admin = TestClient(create_app(), base_url=settings.public_origin)
    recipient = TestClient(create_app(), base_url=settings.public_origin)
    for client in (admin, recipient):
        client.headers["Origin"] = settings.public_origin
    invited_id = None
    try:
        assert (
            admin.post("/api/auth/login", json={"email": email, "password": password}).status_code
            == 200
        )
        admin.headers["X-CSRF-Token"] = admin.cookies.get("openslate_csrf")
        invited = admin.post(
            "/api/auth/invitations",
            json={"email": invite_email, "username": f"invited-{uuid4().hex[:16]}"},
        )
        assert invited.status_code == 201
        assert set(invited.json()) == {"user", "delivery"}
        assert invited.json()["delivery"] == "email"
        with Session(owner) as db:
            user = db.scalar(select(User).where(User.email == invite_email))
            assert user is not None and user.status == "pending"
            invited_id = user.id
        action = _email_action(provider_mail, invite_email, "invite")
        chosen = token_urlsafe(32)
        completed = recipient.post(
            "/api/auth/invitations/complete", json={"token_hash": action, "password": chosen}
        )
        assert completed.status_code == 204
        assert recipient.get("/api/auth/me").status_code == 401
        assert (
            recipient.post(
                "/api/auth/login", json={"email": invite_email, "password": chosen}
            ).status_code
            == 200
        )
        before_recovery = recipient.cookies.get("openslate_access")
        assert (
            recipient.post("/api/auth/recovery/request", json={"email": invite_email}).status_code
            == 204
        )
        recovery = _email_action(provider_mail, invite_email, "recovery")
        replacement = token_urlsafe(32)
        assert (
            recipient.post(
                "/api/auth/recovery/complete",
                json={"token_hash": recovery, "password": replacement},
            ).status_code
            == 204
        )
        recipient.cookies.clear()
        recipient.headers["Authorization"] = f"Bearer {before_recovery}"
        assert recipient.get("/api/auth/me").status_code == 401
        recipient.headers.pop("Authorization")
        assert (
            recipient.post(
                "/api/auth/login", json={"email": invite_email, "password": chosen}
            ).status_code
            == 401
        )
        assert (
            recipient.post(
                "/api/auth/login", json={"email": invite_email, "password": replacement}
            ).status_code
            == 200
        )
    finally:
        admin.close()
        recipient.close()
        with Session(owner) as db:
            user = db.scalar(select(User).where(User.email == invite_email))
            if user is not None:
                invited_id = user.id
                if user.supabase_user_id is not None:
                    removed = httpx.delete(
                        settings.supabase_url + f"/auth/v1/admin/users/{user.supabase_user_id}",
                        headers={"apikey": settings.supabase_secret_key.get_secret_value()},
                        timeout=10,
                    )
                    assert removed.status_code in {200, 204, 404}
                for session in db.scalars(
                    select(IdentitySession).where(IdentitySession.user_id == invited_id)
                ):
                    db.delete(session)
                db.delete(user)
                db.commit()
