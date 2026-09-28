"""Cross-process SSE system acceptance on the runner-owned Supabase stack."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from secrets import token_urlsafe
from typing import BinaryIO
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.config.provider_instance import assert_provider_instance
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User, UserStatus
from app.systems.sandbox.departments.models import Department
from tests.conftest import guarded_create_engine
from tests.postgres_runtime import write_worker_database_manifest

pytestmark = pytest.mark.integration

_API_STARTUP_TIMEOUT_SECONDS = 30
_API_STREAM_READ_TIMEOUT_SECONDS = 12


@dataclass(frozen=True, slots=True)
class ProviderIdentity:
    email: str
    password: str
    owner_engine: Engine


@dataclass(slots=True)
class ApiProcess:
    process: subprocess.Popen[bytes]
    port: int
    log: BinaryIO

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        if self.process.poll() is None:
            try:
                self.process.terminate()
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                try:
                    self.process.kill()
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=5)
        self.log.close()


@pytest.fixture
def provider_identity(tmp_path: Path) -> Iterator[ProviderIdentity]:
    settings = get_settings()
    assert_provider_instance(
        dict(os.environ), database_url=settings.database_url, expected_user="openslate_runtime"
    )
    email = f"provider-sse-{uuid4().hex}@example.test"
    password = _synthetic_password()
    provider_user_id: UUID | None = None
    local_user_id: UUID | None = None
    owner_engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    admin = httpx.Client(
        base_url=settings.supabase_url.rstrip("/") + "/auth/v1/",
        headers={"apikey": settings.supabase_secret_key.get_secret_value()},
        timeout=15,
        trust_env=False,
    )
    try:
        created = admin.post(
            "admin/users",
            json={"email": email, "password": password, "email_confirm": True},
        )
        if created.status_code not in {200, 201}:
            raise AssertionError("runner Supabase Auth did not create the synthetic user")
        provider_user_id = UUID(created.json()["id"])

        with Session(owner_engine) as db:
            role = "admin"
            if role is None:
                raise AssertionError("baseline application admin role is missing")
            created_user = User(
                email=email,
                username=f"provider-sse-{uuid4().hex}",
                status=UserStatus.ACTIVE.value,
                role=role,
                supabase_user_id=provider_user_id,
            )
            db.add(created_user)
            db.commit()
            local_user_id = created_user.id

        yield ProviderIdentity(email, password, owner_engine)
    finally:
        admin.close()
        try:
            if provider_user_id is not None:
                with httpx.Client(
                    base_url=settings.supabase_url.rstrip("/") + "/auth/v1/",
                    headers={"apikey": settings.supabase_secret_key.get_secret_value()},
                    timeout=15,
                    trust_env=False,
                ) as provider_admin:
                    deleted = provider_admin.delete(f"admin/users/{provider_user_id}")
                    if deleted.status_code not in {200, 204, 404}:
                        raise AssertionError(
                            "runner Supabase Auth did not remove the synthetic user"
                        )
        finally:
            try:
                if local_user_id is not None:
                    with Session(owner_engine) as db:
                        sessions = db.scalars(
                            select(IdentitySession).where(IdentitySession.user_id == local_user_id)
                        ).all()
                        for session in sessions:
                            db.delete(session)
                        existing_user = db.get(User, local_user_id)
                        if existing_user is not None:
                            db.delete(existing_user)
                        db.commit()
            finally:
                owner_engine.dispose()
                _remove_private_fixture_files(tmp_path)


def test_two_api_processes_deliver_opaque_invalidation_and_recheck_revoked_session(
    provider_identity: ProviderIdentity,
    tmp_path: Path,
) -> None:
    runtime_url = os.environ["DATABASE_URL"]
    run_id = os.environ["OPENSLATE_FULLSTACK_RUN_ID"]
    manifest = write_worker_database_manifest(
        Path(os.environ["OPENSLATE_TEST_DATABASE_MANIFEST"]),
        tmp_path / "api-runtime-database.json",
        run_id=run_id,
        runtime_database_url=runtime_url,
    )
    port_a, port_b = _reserve_distinct_ports()
    processes: list[ApiProcess] = []
    department_id: UUID | None = None
    department_name = f"sse-cross-process-{uuid4().hex}"

    try:
        api_a = _start_api_process(port_a, "a", manifest, tmp_path)
        processes.append(api_a)
        _wait_for_api(api_a)
        api_b = _start_api_process(port_b, "b", manifest, tmp_path)
        processes.append(api_b)
        _wait_for_api(api_b)
        if api_a.process.pid == api_b.process.pid or api_a.port == api_b.port:
            raise AssertionError("SSE acceptance requires two distinct API processes and ports")

        timeout = httpx.Timeout(connect=3, read=_API_STREAM_READ_TIMEOUT_SECONDS, write=3, pool=3)
        with (
            httpx.Client(base_url=api_a.base_url, timeout=timeout, trust_env=False) as client_a,
            httpx.Client(base_url=api_b.base_url, timeout=timeout, trust_env=False) as client_b,
        ):
            login = client_b.post(
                "/api/auth/token",
                json={"email": provider_identity.email, "password": provider_identity.password},
            )
            if login.status_code != 200:
                raise AssertionError("synthetic user could not authenticate through the API")
            access_token = login.json()["access_token"]
            auth_headers = {"Authorization": f"Bearer {access_token}"}

            with client_a.stream("GET", "/api/events", headers=auth_headers) as stream:
                _require_sse_response(stream)
                stream_lines = iter(stream.iter_lines())
                _require_resync(_read_sse_event(stream_lines))

                department_id = _seed_closed_department(
                    provider_identity.owner_engine, department_name
                )
                reopened = client_b.post(
                    f"/api/departments/{department_id}/reopen",
                    json={"confirmed": True},
                    headers=auth_headers,
                )
                if reopened.status_code != 200:
                    raise AssertionError("authorized department mutation failed through API B")

                event_name, event_data = _read_sse_event(stream_lines)
                if event_name != "invalidate":
                    raise AssertionError("API A did not receive the cross-process invalidation")
                if department_name in event_data:
                    raise AssertionError("SSE exposed department row content")
                try:
                    event_payload = json.loads(event_data)
                except ValueError:
                    raise AssertionError("SSE invalidation was not valid JSON") from None
                expected_payload = {"entity": "departments"}
                if event_payload != expected_payload:
                    raise AssertionError("SSE did not contain only opaque invalidation metadata")

            with client_a.stream("GET", "/api/events", headers=auth_headers) as reconnected:
                _require_sse_response(reconnected)
                reconnect_lines = iter(reconnected.iter_lines())
                _require_resync(_read_sse_event(reconnect_lines))
                refetched = client_a.get(
                    "/api/departments",
                    params={"search": department_name},
                    headers=auth_headers,
                )
                if refetched.status_code != 200:
                    raise AssertionError("API A could not refetch after SSE reconnect")
                items = refetched.json().get("items", [])
                if not any(item.get("department_name") == department_name for item in items):
                    raise AssertionError("SSE reconnect did not permit the authorized refetch")

            sessions_response = client_b.get("/api/auth/sessions", headers=auth_headers)
            if sessions_response.status_code != 200:
                raise AssertionError("API B could not list the synthetic user's app sessions")
            current_sessions = [
                session for session in sessions_response.json() if session.get("current") is True
            ]
            if len(current_sessions) != 1:
                raise AssertionError("the synthetic identity did not have one current app session")
            revoked = client_b.delete(
                f"/api/auth/sessions/{current_sessions[0]['id']}", headers=auth_headers
            )
            if revoked.status_code != 204:
                raise AssertionError("API B could not revoke the synthetic app session")

            with client_a.stream("GET", "/api/events", headers=auth_headers) as denied:
                if denied.status_code != 401:
                    denied.close()
                    raise AssertionError("API A accepted an SSE reconnect after session revocation")
                body = denied.read().decode("utf-8", errors="replace")
                if department_name in body or str(department_id) in body:
                    raise AssertionError("revoked SSE reconnect exposed protected department data")
    finally:
        for api_process in reversed(processes):
            api_process.stop()
        if department_id is not None:
            with provider_identity.owner_engine.begin() as connection:
                # Reopening the department creates its Board, which references it.
                connection.execute(
                    text(
                        "DELETE FROM public.audit_logs WHERE entity_type = 'boards' "
                        "AND entity_id IN (SELECT id FROM public.boards "
                        "WHERE department_id = :department_id)"
                    ),
                    {"department_id": department_id},
                )
                connection.execute(
                    text("DELETE FROM public.boards WHERE department_id = :department_id"),
                    {"department_id": department_id},
                )
                connection.execute(
                    text(
                        "DELETE FROM public.audit_logs "
                        "WHERE entity_type = 'departments' AND entity_id = :department_id"
                    ),
                    {"department_id": department_id},
                )
                connection.execute(
                    text("DELETE FROM public.departments WHERE id = :department_id"),
                    {"department_id": department_id},
                )


def _seed_closed_department(owner_engine: Engine, department_name: str) -> UUID:
    """Commit a closed department without an invalidation; API B then reopens it."""

    with Session(owner_engine) as db:
        department = Department(
            department_name=department_name,
            is_deleted=True,
            deleted_at=datetime.now(UTC),
        )
        db.add(department)
        db.flush()
        department_id = department.id
        db.commit()
    return department_id


def _synthetic_password() -> str:
    return token_urlsafe(32)


def _remove_private_fixture_files(directory: Path) -> None:
    manifest = directory / "api-runtime-database.json"
    manifest.unlink(missing_ok=True)


def _reserve_distinct_ports() -> tuple[int, int]:
    ports: set[int] = set()
    while len(ports) < 2:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            ports.add(listener.getsockname()[1])
    first, second = sorted(ports)
    return first, second


def _api_child_environment(port: int, label: str, manifest: Path, log_dir: Path) -> dict[str, str]:
    setting_keys = {
        name.upper() for name, field in Settings.model_fields.items() if field.is_required()
    }
    environment = {key: os.environ[key] for key in setting_keys if key in os.environ}
    environment.update(
        {
            "PATH": os.environ["PATH"],
            "OPENSLATE_ENV_SOURCE": "process",
            "OPENSLATE_FULLSTACK_RUN_ID": os.environ["OPENSLATE_FULLSTACK_RUN_ID"],
            "OPENSLATE_TEST_DATABASE_MANIFEST": str(manifest),
            "E2E_ALLOW_MUTATIONS": "true",
            "SUPABASE_STORAGE_URL": os.environ["SUPABASE_STORAGE_URL"],
            "PGAPPNAME": f"openslate-sse-{label}",
            "SMTP_HOST": os.environ["SMTP_HOST"],
            "SMTP_PORT": os.environ["SMTP_PORT"],
            "SMTP_ADMIN_EMAIL": os.environ["SMTP_ADMIN_EMAIL"],
            "BACKEND_BIND_HOST": "127.0.0.1",
            "BACKEND_PORT": str(port),
            "LOG_DIR": str(log_dir),
        }
    )
    forbidden = {
        "DATABASE_BOOTSTRAP_URL",
        "DATABASE_INSPECTOR_URL",
        "MIGRATION_DATABASE_URL",
        "TEST_DATABASE_URL",
    }
    if forbidden & environment.keys():
        raise AssertionError("API child received non-runtime database credentials")
    return environment


def _start_api_process(port: int, label: str, manifest: Path, root: Path) -> ApiProcess:
    log_dir = root / f"api-{label}-logs"
    log_dir.mkdir(mode=0o700)
    log_dir.chmod(0o700)
    log_path = root / f"api-{label}.log"
    log = log_path.open("wb")
    log_path.chmod(0o600)
    try:
        process = subprocess.Popen(
            [sys.executable, "-m", "app"],
            cwd=Path(__file__).resolve().parents[2],
            env=_api_child_environment(port, label, manifest, log_dir),
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    except Exception:
        log.close()
        raise
    return ApiProcess(process=process, port=port, log=log)


def _wait_for_api(api: ApiProcess) -> None:
    deadline = time.monotonic() + _API_STARTUP_TIMEOUT_SECONDS
    with httpx.Client(timeout=2, trust_env=False) as client:
        while time.monotonic() < deadline:
            if api.process.poll() is not None:
                raise AssertionError("an API child exited before becoming ready")
            try:
                response = client.get(api.base_url + "/api/ready")
                if response.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            time.sleep(0.1)
    raise AssertionError("an API child did not become ready before the startup deadline")


def _require_sse_response(response: httpx.Response) -> None:
    content_type = response.headers.get("content-type", "").split(";", maxsplit=1)[0]
    if response.status_code != 200 or content_type != "text/event-stream":
        raise AssertionError("authenticated SSE request was not accepted")


def _require_resync(event: tuple[str, str]) -> None:
    if event != ("resync", "{}"):
        raise AssertionError("SSE connection did not begin with an empty resync")


def _read_sse_event(lines: Iterator[str]) -> tuple[str, str]:
    deadline = time.monotonic() + _API_STREAM_READ_TIMEOUT_SECONDS
    event_name: str | None = None
    data_lines: list[str] = []
    while True:
        if time.monotonic() >= deadline:
            raise AssertionError("SSE event did not arrive before its deadline")
        try:
            line = next(lines)
        except StopIteration:
            break
        except httpx.ReadTimeout:
            raise AssertionError("SSE event did not arrive before its deadline") from None
        if time.monotonic() >= deadline:
            raise AssertionError("SSE event did not arrive before its deadline")
        if not line:
            if event_name is not None or data_lines:
                return event_name or "message", "\n".join(data_lines)
            continue
        if line.startswith(":"):
            continue
        if line.startswith("event:"):
            event_name = line.partition(":")[2].strip()
        elif line.startswith("data:"):
            data_lines.append(line.partition(":")[2].lstrip())
    raise AssertionError("SSE response ended before a complete event arrived")
