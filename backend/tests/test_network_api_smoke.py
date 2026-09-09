"""Opt-in network smoke coverage for the local FastAPI and Supabase boundaries."""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

import httpx
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from uuid6 import uuid7

from app.core.config import Settings, get_settings
from tests.conftest import _assert_alembic_head, _guard_integration_database

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.getenv("OPENSLATE_NETWORK_SMOKE") != "1",
        reason="Set OPENSLATE_NETWORK_SMOKE=1 to run the local network smoke test",
    ),
]


def _local_auth_url(settings: Settings) -> str:
    if not settings.supabase_url:
        raise RuntimeError("SUPABASE_URL is required for the local network smoke test")
    parsed = urlsplit(settings.supabase_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost"}:
        raise RuntimeError("SUPABASE_URL must target local HTTP Supabase Auth")
    if parsed.port != 54321:
        raise RuntimeError("SUPABASE_URL must target the local Supabase API port")
    return settings.supabase_url.rstrip("/")


def _guarded_owner_url(settings: Settings) -> str:
    owner_url = settings.migration_database_url or os.getenv("MIGRATION_DATABASE_URL")
    if owner_url is None:
        raise RuntimeError("MIGRATION_DATABASE_URL is required for network smoke setup")
    _guard_integration_database(owner_url)
    return owner_url


def _guarded_runtime_url(settings: Settings) -> str:
    _guard_integration_database(settings.database_url)
    return settings.database_url


def _ephemeral_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _wait_for_api(process: subprocess.Popen[str], base_url: str) -> None:
    deadline = time.monotonic() + 15.0
    with httpx.Client(base_url=base_url, timeout=1.0) as client:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("The loopback FastAPI process exited before readiness")
            try:
                response = client.get("/api/health")
            except httpx.HTTPError:
                continue
            if response.status_code == 200 and response.json() == {
                "status": "ok",
                "service": "openslate-api",
            }:
                return
    raise RuntimeError("The loopback FastAPI process did not become ready")


@dataclass
class NetworkSmokeContext:
    settings: Settings
    owner_engine: Engine
    auth_base_url: str
    email: str
    password: str
    auth_id: UUID | None = None
    department_id: UUID | None = None
    process: subprocess.Popen[str] | None = None
    api_client: httpx.Client | None = None

    @classmethod
    def prepare(cls) -> NetworkSmokeContext:
        settings = get_settings()
        runtime_url = _guarded_runtime_url(settings)
        owner_url = _guarded_owner_url(settings)
        auth_base_url = _local_auth_url(settings)
        if settings.supabase_secret_key is None or settings.supabase_publishable_key is None:
            raise RuntimeError("Both local Supabase Auth keys are required")

        runtime_engine = create_engine(runtime_url)
        owner_engine = create_engine(owner_url)
        context: NetworkSmokeContext | None = None
        try:
            with runtime_engine.connect() as connection:
                if connection.scalar(text("SELECT current_user")) != "openslate_runtime":
                    raise RuntimeError("DATABASE_URL must connect as openslate_runtime")
                _assert_alembic_head(connection)
                connection.rollback()
            with owner_engine.connect() as connection:
                _assert_alembic_head(connection)
                connection.rollback()

            admin_role_id = cls._eligible_admin_role(owner_engine)
            email = f"network-smoke-{uuid7().hex}@example.com"
            password = f"NetworkSmoke-{uuid7().hex[:20]}!9"
            context = cls(
                settings=settings,
                owner_engine=owner_engine,
                auth_base_url=auth_base_url,
                email=email,
                password=password,
            )
            context._create_auth_user(admin_role_id)
            context._issue_access_token()
            return context
        except BaseException as error:
            if context is not None:
                cleanup_error = context.cleanup()
                if cleanup_error is not None:
                    raise RuntimeError("network smoke setup cleanup failed") from error
            else:
                owner_engine.dispose()
            raise
        finally:
            runtime_engine.dispose()

    @staticmethod
    def _eligible_admin_role(owner_engine: Engine) -> UUID:
        with owner_engine.connect() as connection:
            role_id = connection.scalar(
                text(
                    "SELECT id FROM public.roles "
                    "WHERE role = 'admin' AND is_deleted = false ORDER BY id LIMIT 1"
                )
            )
            admin_count = connection.scalar(
                text(
                    "SELECT count(*) FROM public.users AS u "
                    "JOIN public.roles AS r ON r.id = u.role_id "
                    "WHERE u.status = 'active' AND u.is_deleted = false "
                    "AND r.role = 'admin' AND r.is_deleted = false "
                    "AND (u.invitation_accepted_at IS NOT NULL "
                    "OR (u.invitation_sent_at IS NULL AND u.invitation_accepted_at IS NULL))"
                )
            )
            connection.rollback()
        if not isinstance(role_id, UUID):
            raise RuntimeError("The local database has no active admin role")
        if int(admin_count or 0) < 1:
            raise RuntimeError("The local database must retain an eligible administrator")
        return role_id

    def _admin_headers(self) -> dict[str, str]:
        assert self.settings.supabase_secret_key is not None
        key = self.settings.supabase_secret_key.get_secret_value()
        return {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def _create_auth_user(self, admin_role_id: UUID) -> None:
        assert self.settings.supabase_secret_key is not None
        with httpx.Client(
            base_url=self.auth_base_url,
            headers=self._admin_headers(),
            timeout=10.0,
        ) as client:
            response = client.post(
                "/auth/v1/admin/users",
                json={
                    "email": self.email,
                    "password": self.password,
                    "email_confirm": True,
                },
            )
            try:
                response.raise_for_status()
                payload = response.json()
            except (httpx.HTTPStatusError, ValueError):
                self.auth_id = self._resolve_auth_identity()
                raise
        try:
            self.auth_id = UUID(str(payload["id"]))
        except (KeyError, TypeError, ValueError) as error:
            self.auth_id = self._resolve_auth_identity()
            if self.auth_id is not None:
                raise RuntimeError(
                    "Local Supabase Auth returned an unusable test identity"
                ) from error
            raise RuntimeError("Local Supabase Auth returned no usable test identity") from error

        with self.owner_engine.begin() as connection:
            updated = connection.execute(
                text(
                    "UPDATE public.users SET username = :username, status = 'active', "
                    "role_id = :role_id, invitation_sent_at = NULL, "
                    "invitation_accepted_at = NULL, is_deleted = false, deleted_at = NULL "
                    "WHERE id = :user_id"
                ),
                {
                    "username": f"network_{self.auth_id.hex[:20]}",
                    "role_id": admin_role_id,
                    "user_id": self.auth_id,
                },
            )
            if updated.rowcount != 1:
                raise RuntimeError("Local Auth identity did not produce an application profile")

    def _resolve_auth_identity(self) -> UUID | None:
        with self.owner_engine.connect() as connection:
            identities = connection.execute(
                text("SELECT id FROM auth.users WHERE email = :email"),
                {"email": self.email},
            ).scalars().all()
            connection.rollback()
        if len(identities) > 1:
            raise RuntimeError("The network smoke test email matched multiple Auth identities")
        return UUID(str(identities[0])) if identities else None

    def _issue_access_token(self) -> None:
        assert self.settings.supabase_publishable_key is not None
        key = self.settings.supabase_publishable_key.get_secret_value()
        with httpx.Client(
            base_url=self.auth_base_url,
            headers={"apikey": key, "Content-Type": "application/json"},
            timeout=10.0,
        ) as client:
            response = client.post(
                "/auth/v1/token",
                params={"grant_type": "password"},
                json={"email": self.email, "password": self.password},
            )
            response.raise_for_status()
            payload = response.json()
        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("Local Supabase Auth returned no access token")
        self.api_client = httpx.Client(
            base_url=self._start_server(),
            headers={"Authorization": f"Bearer {token}"},
            timeout=10.0,
        )

    def _start_server(self) -> str:
        port = _ephemeral_port()
        backend_dir = Path(__file__).parents[1]
        environment = os.environ.copy()
        environment["PYTHONPATH"] = os.pathsep.join(
            [str(backend_dir), environment.get("PYTHONPATH", "")]
        ).rstrip(os.pathsep)
        self.process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "app.main:app",
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
            ],
            cwd=backend_dir,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        base_url = f"http://127.0.0.1:{port}"
        _wait_for_api(self.process, base_url)
        return base_url

    def cleanup(self) -> BaseException | None:
        failures: list[str] = []
        if self.api_client is not None:
            self.api_client.close()
        if self.process is not None:
            try:
                if self.process.poll() is None:
                    self.process.terminate()
                self.process.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired) as error:
                failures.append(f"FastAPI process cleanup failed: {type(error).__name__}")
                if self.process.poll() is None:
                    self.process.kill()
                    self.process.wait(timeout=10)

        try:
            self._cleanup_database_rows()
        except BaseException as error:
            failures.append(f"database cleanup failed: {type(error).__name__}")
        try:
            self._delete_auth_user()
        except BaseException as error:
            failures.append(f"Auth cleanup failed: {type(error).__name__}")
        self.owner_engine.dispose()
        if failures:
            return RuntimeError("; ".join(failures))
        return None

    def _cleanup_database_rows(self) -> None:
        if self.department_id is None and self.auth_id is None:
            return
        department_ids: set[UUID] = set()
        if self.department_id is not None:
            department_ids.add(self.department_id)
        with self.owner_engine.begin() as connection:
            if self.auth_id is not None:
                department_ids.update(
                    connection.execute(
                        text(
                            "SELECT id FROM public.departments "
                            "WHERE performed_by = :actor_id"
                        ),
                        {"actor_id": self.auth_id},
                    ).scalars()
                )
            for department_id in department_ids:
                connection.execute(
                    text("DELETE FROM public.audit_logs WHERE entity_id = :entity_id"),
                    {"entity_id": department_id},
                )
                deleted = connection.execute(
                    text("DELETE FROM public.departments WHERE id = :department_id"),
                    {"department_id": department_id},
                )
                if deleted.rowcount != 1:
                    raise RuntimeError("The test department was not removed")

    def _delete_auth_user(self) -> None:
        if self.auth_id is None:
            return
        assert self.settings.supabase_secret_key is not None
        with httpx.Client(
            base_url=self.auth_base_url,
            headers=self._admin_headers(),
            timeout=10.0,
        ) as client:
            response = client.delete(f"/auth/v1/admin/users/{self.auth_id}")
            response.raise_for_status()
        with self.owner_engine.connect() as connection:
            remaining = connection.scalar(
                text("SELECT count(*) FROM auth.users WHERE id = :user_id"),
                {"user_id": self.auth_id},
            )
            profile = connection.scalar(
                text("SELECT count(*) FROM public.users WHERE id = :user_id"),
                {"user_id": self.auth_id},
            )
            connection.rollback()
        if int(remaining or 0) != 0 or int(profile or 0) != 0:
            raise RuntimeError("The test Auth identity was not fully removed")


@pytest.fixture(scope="module")
def network_api() -> Iterator[NetworkSmokeContext]:
    context: NetworkSmokeContext | None = None
    try:
        context = NetworkSmokeContext.prepare()
        assert context.api_client is not None
        yield context
    finally:
        if context is not None:
            cleanup_error = context.cleanup()
            if cleanup_error is not None:
                raise cleanup_error


def test_network_api_smoke_contract(network_api: NetworkSmokeContext) -> None:
    assert network_api.api_client is not None
    client = network_api.api_client
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["id"] == str(network_api.auth_id)
    assert me.json()["role"] == "admin"

    denied = httpx.get(f"{client.base_url}/api/auth/me", timeout=10.0)
    assert denied.status_code == 401
    assert denied.headers["www-authenticate"] == "Bearer"
    invalid = httpx.get(
        f"{client.base_url}/api/auth/me",
        headers={"Authorization": "Bearer invalid-network-smoke-token"},
        timeout=10.0,
    )
    assert invalid.status_code == 401
    assert invalid.headers["www-authenticate"] == "Bearer"

    invalid_payload = client.post("/api/departments", json={"department_name": ""})
    assert invalid_payload.status_code == 422

    created = client.post(
        "/api/departments",
        json={"department_name": f"Network Smoke {uuid7().hex[:12]}"},
    )
    assert created.status_code == 201
    network_api.department_id = UUID(created.json()["id"])

    fetched = client.get(f"/api/departments/{network_api.department_id}")
    assert fetched.status_code == 200
    assert fetched.json()["id"] == str(network_api.department_id)

    close_required = client.delete(f"/api/departments/{network_api.department_id}")
    assert close_required.status_code == 409
    assert close_required.json()["detail"]["code"] == "close_required"
    still_present = client.get(f"/api/departments/{network_api.department_id}")
    assert still_present.status_code == 200

    openapi = client.get("/openapi.json")
    assert openapi.status_code == 200
    responses = openapi.json()["paths"]["/api/departments/{department_id}"]["delete"]["responses"]
    assert "409" in responses
    assert "204" not in responses
