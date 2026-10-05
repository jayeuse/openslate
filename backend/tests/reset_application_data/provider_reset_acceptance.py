"""Destructive reset CLI acceptance for its separately owned fresh Supabase run."""

from __future__ import annotations

import hashlib
import os
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from uuid6 import uuid7

from app.core.config import get_settings
from app.core.config.provider_instance import assert_provider_instance
from app.core.database.session import AuditSession
from app.systems.access.users.models import User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext
from app.systems.platform.files.models import File
from app.systems.platform.files.supabase_storage import SupabaseStorage
from app.systems.sandbox.departments.models import Department
from operations.reset import models as reset_models
from operations.reset.storage import ResetStorage
from tests import fullstack_runner
from tests.conftest import _guard_integration_database, guarded_create_engine
from tests.reset_application_data.provider_reset_cli import dry_run_digest, tty_reset

pytestmark = pytest.mark.integration


def _owned_environment() -> tuple[dict[str, str], str, str]:
    values = dict(os.environ)
    if (
        values.get("OPENSLATE_TEST_RESET_ACCEPTANCE") != "1"
        or values.get("OPENSLATE_ENV_SOURCE") != "process"
        or values.get("ENVIRONMENT") != "test"
    ):
        raise RuntimeError("Provider reset acceptance requires its dedicated test environment")
    owner_url = values.get("MIGRATION_DATABASE_URL", "")
    runtime_url = values.get("TEST_DATABASE_URL", "")
    run_id = values.get("OPENSLATE_FULLSTACK_RUN_ID", "")
    if not owner_url or not runtime_url or not run_id:
        raise RuntimeError("Provider reset acceptance inputs are incomplete")
    _guard_integration_database(runtime_url)
    assert_provider_instance(values, database_url=runtime_url, expected_user="openslate_runtime")
    return values, owner_url, run_id


def _provider_user_present(
    provider_origin: str, headers: dict[str, str], timeout: float, user_id: UUID
) -> bool:
    try:
        response = httpx.get(
            f"{provider_origin}/admin/users/{user_id}",
            headers=headers,
            timeout=timeout,
            follow_redirects=False,
            trust_env=False,
        )
    except httpx.RequestError:
        raise RuntimeError("The disposable Supabase Auth API is unavailable") from None
    if response.status_code == 404:
        return False
    if response.status_code != 200:
        raise RuntimeError("The disposable Supabase Auth identity could not be verified")
    try:
        return UUID(response.json()["id"]) == user_id
    except (KeyError, TypeError, ValueError):
        raise RuntimeError("The disposable Supabase Auth identity was malformed") from None


def _table_counts(owner_url: str) -> tuple[tuple[str, int], ...]:
    engine = guarded_create_engine(owner_url)
    try:
        with engine.connect() as connection:
            return tuple(
                (
                    table_name,
                    int(connection.scalar(text(f"SELECT count(*) FROM public.{table_name}"))),
                )
                for table_name in reset_models.APPLICATION_TABLES
            )
    finally:
        engine.dispose()


def _assert_fresh_baseline(owner_url: str, storage_inventory: ResetStorage) -> None:
    counts = dict(_table_counts(owner_url))
    if counts.get("users") != 0 or counts.get("files") != 0:
        raise RuntimeError("Provider reset acceptance requires fresh users and files tables")
    if any(counts[name] for name in reset_models.NON_PRESERVED_TABLES):
        raise RuntimeError("Provider reset acceptance refuses existing application data")
    if storage_inventory.list_object_keys():
        raise RuntimeError("Provider reset acceptance requires empty private Storage buckets")


def _seeded_identities(
    owner_url: str, run_id: str, values: dict[str, str]
) -> tuple[UUID, UUID, str, str]:
    identities = fullstack_runner.seed(owner_url, run_id, values)
    if set(identities) != {"admin", "member"}:
        raise RuntimeError("The disposable identity seed was incomplete")
    admin_id, member_id = UUID(identities["admin"]["id"]), UUID(identities["member"]["id"])
    admin_email = identities["admin"]["email"].strip().casefold()
    admin_password = identities["admin"]["password"]
    if not admin_email or not admin_password:
        raise RuntimeError("The disposable administrator credentials were incomplete")
    return admin_id, member_id, admin_email, admin_password


def _provider_bindings(owner_url: str, admin_id: UUID, member_id: UUID) -> tuple[UUID, UUID]:
    engine = guarded_create_engine(owner_url)
    try:
        with AuditSession(engine) as database:
            admin = database.get(User, admin_id)
            member = database.get(User, member_id)
            if (
                admin is None
                or member is None
                or admin.supabase_user_id is None
                or member.supabase_user_id is None
            ):
                raise RuntimeError("The runner did not create bound provider identities")
            return admin.supabase_user_id, member.supabase_user_id
    finally:
        engine.dispose()


def _create_reset_fixture(
    owner_url: str,
    admin_id: UUID,
    storage_objects: SupabaseStorage,
) -> tuple[tuple[str, str], tuple[bytes, bytes]]:
    uploading_key, ready_key = uuid4().hex, uuid4().hex
    uploading_bytes = b"reset-acceptance-uploading-object"
    ready_bytes = b"reset-acceptance-ready-object"
    storage_objects.upload(uploading_key, uploading_bytes, "application/octet-stream")
    storage_objects.upload(ready_key, ready_bytes, "application/octet-stream")

    engine = guarded_create_engine(owner_url)
    try:
        with AuditSession(engine) as database:
            database.info[AUDIT_CONTEXT_KEY] = AuditContext(
                request_id=uuid7(),
                request_method="POST",
                request_path="/api/test/provider-reset-acceptance",
            )
            database.add(Department(department_name=f"Reset {uuid4().hex}"))
            database.add_all(
                (
                    File(
                        purpose="library_document",
                        creator_id=admin_id,
                        filename="uploading-fixture.bin",
                        media_type="application/octet-stream",
                        expected_size=len(uploading_bytes),
                        object_key=uploading_key,
                        state="uploading",
                    ),
                    File(
                        purpose="library_document",
                        creator_id=admin_id,
                        filename="ready-fixture.bin",
                        media_type="application/octet-stream",
                        expected_size=len(ready_bytes),
                        actual_size=len(ready_bytes),
                        digest=hashlib.sha256(ready_bytes).hexdigest(),
                        object_key=ready_key,
                        state="ready",
                    ),
                )
            )
            database.commit()
    finally:
        engine.dispose()
    return (uploading_key, ready_key), (uploading_bytes, ready_bytes)


def _login_seeded_admin(admin_email: str, password: str, settings: Any) -> tuple[str, TestClient]:
    from app.main import create_app

    client = TestClient(create_app(), base_url=settings.public_origin)
    client.headers["Origin"] = settings.public_origin
    response = client.post("/api/auth/login", json={"email": admin_email, "password": password})
    if response.status_code != 200:
        client.close()
        raise RuntimeError("The seeded administrator could not log in through FastAPI")
    access = client.cookies.get("openslate_access")
    if not access:
        client.close()
        raise RuntimeError("FastAPI did not issue the expected browser session cookie")
    return access, client


def _storage_bytes(
    inventory: ResetStorage, objects: SupabaseStorage
) -> tuple[tuple[str, int, str], ...]:
    observed: list[tuple[str, int, str]] = []
    for full_key in inventory.list_object_keys():
        bucket, separator, object_key = full_key.partition("/")
        if not separator:
            raise RuntimeError("The disposable Storage inventory was invalid")
        content = objects.download(object_key) if bucket == "openslate-ready" else None
        if content is None:
            raise RuntimeError("A listed disposable Storage object could not be read")
        observed.append((full_key, len(content), hashlib.sha256(content).hexdigest()))
    return tuple(observed)


def _row(connection: Any, statement: str) -> tuple[Any, ...]:
    return tuple(connection.execute(text(statement)).one())


def _observed_state(
    owner_url: str,
    inventory: ResetStorage,
    objects: SupabaseStorage,
    settings: Any,
    admin_provider_id: UUID,
    member_provider_id: UUID,
) -> tuple[Any, ...]:
    engine = guarded_create_engine(owner_url)
    try:
        with engine.connect() as connection:
            tables: list[tuple[str, int, str]] = []
            for table_name in reset_models.APPLICATION_TABLES:
                statement = (
                    "SELECT count(*), md5(coalesce(string_agg(row_data::text, chr(10) "
                    "ORDER BY row_data::text), '')) FROM ("
                    f"SELECT to_jsonb(source) AS row_data FROM public.{table_name} AS source"
                    ") AS snapshot"
                )
                count, digest = connection.execute(text(statement)).one()
                tables.append((table_name, int(count), str(digest)))
    finally:
        engine.dispose()
    provider_origin = str(settings.supabase_url).rstrip("/") + "/auth/v1"
    provider_headers = {"apikey": settings.supabase_secret_key.get_secret_value()}
    provider_timeout = float(settings.supabase_timeout_seconds)
    provider_state = (
        _provider_user_present(
            provider_origin, provider_headers, provider_timeout, admin_provider_id
        ),
        _provider_user_present(
            provider_origin, provider_headers, provider_timeout, member_provider_id
        ),
    )
    return (
        tuple(tables),
        provider_state,
        _storage_bytes(inventory, objects),
    )


def _assert_after_reset(
    observed: tuple[Any, ...],
    admin_id: UUID,
    admin_email: str,
    admin_provider_id: UUID,
    member_provider_id: UUID,
) -> None:
    tables, provider_state, objects = observed
    counts = {name: count for name, count, _digest in tables}
    if any(counts[name] for name in reset_models.NON_PRESERVED_TABLES):
        pytest.fail("The CLI left application data in a non-preserved table")
    engine = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    try:
        with engine.connect() as connection:
            queries = {
                "admin": "SELECT u.id, u.email, u.supabase_user_id, u.status, u.role "
                "FROM public.users AS u",
                "invitations": "SELECT invitation_expiry_days, guest_duration_days "
                "FROM public.workspace_profiles",
                "workspace": "SELECT logo_file_id FROM public.workspace_profiles",
                "sandbox": "SELECT singleton_key, schema_version, revision, performed_by, "
                "deleted_at, is_deleted FROM public.sandbox_documents",
            }
            state = {name: _row(connection, query) for name, query in queries.items()}
    finally:
        engine.dispose()
    if state["admin"] != (admin_id, admin_email, admin_provider_id, "active", "admin"):
        pytest.fail("The CLI did not preserve exactly the configured administrator profile")
    if state["invitations"] != (7, 30):
        pytest.fail("The CLI did not restore the invitation settings")
    if state["workspace"] != (None,) or state["sandbox"] != (True, 4, 1, None, None, False):
        pytest.fail("The CLI did not restore the workspace and Sandbox defaults")
    if provider_state != (True, False):
        pytest.fail("The CLI did not retain only the administrator Auth identity")
    if objects:
        pytest.fail("The CLI left objects or bytes in private Supabase Storage")


def test_reset_cli_dry_run_confirmation_and_execute_against_fresh_provider() -> None:
    values, owner_url, run_id = _owned_environment()
    settings = get_settings()
    inventory = ResetStorage(
        values["SUPABASE_URL"],
        settings.supabase_secret_key.get_secret_value(),
        settings.supabase_timeout_seconds,
    )
    objects = SupabaseStorage(
        values["SUPABASE_URL"],
        settings.supabase_secret_key.get_secret_value(),
        settings.supabase_timeout_seconds,
    )

    _assert_fresh_baseline(owner_url, inventory)
    admin_id, member_id, admin_email, password = _seeded_identities(owner_url, run_id, values)
    admin_provider_id, member_provider_id = _provider_bindings(owner_url, admin_id, member_id)
    access_token, browser = _login_seeded_admin(admin_email, password, settings)
    try:
        object_keys, content = _create_reset_fixture(owner_url, admin_id, objects)

        def observed_state() -> tuple[Any, ...]:
            return _observed_state(
                owner_url,
                inventory,
                objects,
                settings,
                admin_provider_id,
                member_provider_id,
            )

        before = observed_state()
        tables = {name: count for name, count, _digest in before[0]}
        if tables["identity_sessions"] != 1:
            raise RuntimeError("The real administrator login did not create one local session")
        if tables["files"] != 2 or tables["departments"] != 1:
            raise RuntimeError(
                "The disposable reset fixture did not create app rows and file metadata"
            )
        if before[1] != (True, True):
            raise RuntimeError("The disposable reset fixture did not bind both Auth identities")
        expected_objects = sorted(
            zip((f"openslate-ready/{key}" for key in object_keys), content, strict=True)
        )
        if tuple(key for key, _size, _digest in before[2]) != tuple(
            key for key, _content in expected_objects
        ):
            raise RuntimeError("The disposable Storage fixture did not populate the private bucket")
        for actual, (_key, expected) in zip(before[2], expected_objects, strict=True):
            if actual[1] != len(expected) or actual[2] != hashlib.sha256(expected).hexdigest():
                raise RuntimeError("The disposable Storage bytes did not match their test fixture")

        command_env = dict(values)
        command_env.update(
            OPENSLATE_ENV_SOURCE="process",
            OPENSLATE_TEST_RESET_ACCEPTANCE="1",
            ADMIN_EMAIL=admin_email,
        )
        digest = dry_run_digest(command_env)
        after_dry_run = observed_state()
        if after_dry_run != before:
            pytest.fail("The real reset CLI dry run changed application, Auth, or Storage state")

        wrong_digest = "0" * 64 if digest != "0" * 64 else "1" * 64
        wrong_status, wrong_prompt, rejected, wrong_success = tty_reset(
            command_env, wrong_digest, expect_rejection=True
        )
        if wrong_status == 0 or not wrong_prompt or not rejected or wrong_success:
            pytest.fail("The real reset CLI did not reject an incorrect TTY confirmation")
        after_wrong_confirmation = observed_state()
        if after_wrong_confirmation != before:
            pytest.fail(
                "An incorrect reset confirmation changed application, Auth, or Storage state"
            )
    finally:
        browser.close()

    status, prompt, rejected, succeeded = tty_reset(command_env, digest)
    if status != 0 or not prompt or rejected or not succeeded:
        pytest.fail("The real reset CLI did not complete after the exact TTY confirmation")
    after_reset = observed_state()
    _assert_after_reset(after_reset, admin_id, admin_email, admin_provider_id, member_provider_id)
    if any(objects.download(key) is not None for key in object_keys):
        pytest.fail("The reset left a known Storage object readable")

    from app.main import create_app

    stale = TestClient(
        create_app(),
        base_url=settings.public_origin,
        cookies={
            "openslate_access": access_token,
        },
    )
    try:
        if stale.get("/api/auth/me").status_code != 401:
            pytest.fail("An application session survived the completed reset")
    finally:
        stale.close()
