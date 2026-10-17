"""Guarded database access, seed rows, and cleanup shared by the reset integration tests."""

from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from unittest.mock import Mock
from uuid import UUID, uuid4

import pytest
from psycopg import Cursor, connect

from tests.conftest import _guard_integration_database

# The two identity rate-limit buckets each reset integration test seeds and removes.
RATE_LIMIT_FINGERPRINTS = ("1" * 64, "2" * 64)


@dataclass(frozen=True)
class ResetDatabase:
    """The runner-owned disposable database; every connection is guarded first."""

    runtime_url: str
    owner_url: str

    @property
    def url(self) -> str:
        """The owner URL in the form psycopg accepts."""
        return self.owner_url.replace("postgresql+psycopg://", "postgresql://", 1)

    def guard(self) -> None:
        _guard_integration_database(self.runtime_url)
        _guard_integration_database(self.owner_url)

    def clean_up_after(
        self, request: pytest.FixtureRequest, clean: Callable[[Cursor], None]
    ) -> None:
        """Run *clean* in one guarded, committed transaction when the test ends."""

        def cleanup() -> None:
            self.guard()
            with connect(self.url) as database:
                with database.cursor() as cursor:
                    clean(cursor)
                database.commit()

        request.addfinalizer(cleanup)


def guarded_reset_database(monkeypatch: pytest.MonkeyPatch) -> ResetDatabase:
    monkeypatch.setenv("OPENSLATE_ENV_SOURCE", "process")
    runtime_url = os.environ.get("TEST_DATABASE_URL")
    owner_url = os.environ.get("MIGRATION_DATABASE_URL")
    if runtime_url is None or owner_url is None:
        raise RuntimeError("Reset integration requires the disposable PostgreSQL runner")
    database = ResetDatabase(runtime_url, owner_url)
    database.guard()
    return database


def provider_doubles() -> tuple[Mock, Mock]:
    """An empty Storage double and an Auth double."""
    storage = Mock()
    storage.list_object_keys.return_value = ()
    return storage, Mock()


def insert_sessions_and_rate_limits(
    cursor: Cursor, *, admin_id: UUID, member_id: UUID, session_id: UUID
) -> None:
    """One session and one lifecycle bucket for each person, and two identity buckets."""
    cursor.execute(
        "INSERT INTO public.identity_sessions "
        "(id, user_id, refresh_token_digest, csrf_token_digest, created_at, refreshed_at, "
        "expires_at) VALUES (%s, %s, %s, %s, now(), now(), now() + interval '1 day'), "
        "(%s, %s, %s, %s, now(), now(), now() + interval '1 day')",
        (
            session_id,
            admin_id,
            "a" * 64,
            "b" * 64,
            uuid4(),
            member_id,
            "c" * 64,
            "d" * 64,
        ),
    )
    cursor.execute(
        "INSERT INTO public.identity_rate_limit_buckets "
        "(fingerprint, attempt_count, window_started_at) "
        "VALUES (%s, 1, now()), (%s, 1, now())",
        RATE_LIMIT_FINGERPRINTS,
    )
    cursor.execute(
        "INSERT INTO public.lifecycle_rate_limit_buckets "
        "(org_id, id, actor_id, attempt_count, window_started_at, window_expires_at) "
        "VALUES ((SELECT org_id FROM public.memberships WHERE user_id = %s), "
        "%s, %s, 1, now(), now() + interval '1 minute'), "
        "((SELECT org_id FROM public.memberships WHERE user_id = %s), "
        "%s, %s, 1, now(), now() + interval '1 minute')",
        (admin_id, uuid4(), admin_id, member_id, uuid4(), member_id),
    )


def delete_sessions_and_rate_limits(cursor: Cursor, user_ids: Sequence[UUID]) -> None:
    cursor.execute(
        "DELETE FROM public.identity_sessions WHERE user_id = ANY(%s)", (list(user_ids),)
    )
    cursor.execute(
        "DELETE FROM public.lifecycle_rate_limit_buckets WHERE actor_id = ANY(%s)",
        (list(user_ids),),
    )
    cursor.execute(
        "DELETE FROM public.identity_rate_limit_buckets WHERE fingerprint IN (%s, %s)",
        RATE_LIMIT_FINGERPRINTS,
    )


def insert_department(cursor: Cursor, department_id: UUID, admin_id: UUID) -> None:
    cursor.execute(
        "INSERT INTO public.departments (org_id, id, department_name) VALUES "
        "((SELECT org_id FROM public.memberships WHERE user_id = %s), %s, %s)",
        (admin_id, department_id, f"reset-{admin_id}"),
    )


def insert_logo_file(cursor: Cursor, file_id: UUID, admin_id: UUID) -> None:
    cursor.execute(
        "INSERT INTO public.files "
        "(org_id, id, purpose, creator_id, filename, expected_size, object_key, state) "
        "VALUES ((SELECT org_id FROM public.memberships WHERE user_id = %s), "
        "%s, 'workspace_logo', %s, 'reset.png', 1, %s, 'awaiting_upload')",
        (admin_id, file_id, admin_id, uuid4().hex),
    )


@dataclass(frozen=True)
class SecondOrganization:
    """Another organization of the same install, which the reset must remove as well."""

    org_id: UUID
    user_id: UUID
    department_id: UUID


def insert_operator(cursor: Cursor, user_id: UUID) -> UUID:
    """Make the account the installation operator that the reset preserves."""
    operator_id = uuid4()
    cursor.execute(
        "INSERT INTO public.platform_operators (id, user_id) VALUES (%s, %s)",
        (operator_id, user_id),
    )
    return operator_id


def insert_second_organization(cursor: Cursor) -> SecondOrganization:
    """A second organization with its own member, Sandbox draft, department and Boards."""
    second = SecondOrganization(uuid4(), uuid4(), uuid4())
    cursor.execute(
        "INSERT INTO public.organizations (id, slug, display_name, timezone, locale, "
        "theme) VALUES (%s, %s, 'Second reset organization', 'Asia/Manila', 'en-PH', "
        "'whiteboard')",
        (second.org_id, f"reset-second-{second.org_id}"),
    )
    cursor.execute(
        "INSERT INTO public.users (id, email, username, status) VALUES (%s, %s, %s, 'active')",
        (
            second.user_id,
            f"reset-second-{second.user_id}@example.test",
            f"reset_second_{second.user_id.hex[:12]}",
        ),
    )
    cursor.execute(
        "INSERT INTO public.memberships (id, org_id, user_id, role, status) "
        "VALUES (%s, %s, %s, 'admin', 'active')",
        (uuid4(), second.org_id, second.user_id),
    )
    cursor.execute(
        "UPDATE public.organizations SET owner_user_id = %s WHERE id = %s",
        (second.user_id, second.org_id),
    )
    cursor.execute(
        "INSERT INTO public.sandbox_documents (org_id, id, document, content_hash, byte_count) "
        "VALUES (%s, %s, '{}'::jsonb, %s, 2)",
        (second.org_id, uuid4(), "0" * 64),
    )
    cursor.execute(
        "INSERT INTO public.departments (org_id, id, department_name) VALUES (%s, %s, %s)",
        (second.org_id, second.department_id, f"reset-second-{second.department_id}"),
    )
    cursor.execute(
        "INSERT INTO public.boards (org_id, id, scope, department_id, name) VALUES "
        "(%s, %s, 'company', NULL, 'Company Board'), (%s, %s, 'department', %s, 'Second')",
        (second.org_id, uuid4(), second.org_id, uuid4(), second.department_id),
    )
    return second


def delete_second_organization(cursor: Cursor, second: SecondOrganization) -> None:
    """Remove what ``insert_second_organization`` created when a reset did not."""
    for table in ("boards", "departments", "sandbox_documents", "memberships"):
        cursor.execute(f"DELETE FROM public.{table} WHERE org_id = %s", (second.org_id,))
    cursor.execute("DELETE FROM public.organizations WHERE id = %s", (second.org_id,))
    cursor.execute("DELETE FROM public.users WHERE id = %s", (second.user_id,))


def assert_only_the_operator_remains(
    cursor: Cursor, admin_id: UUID, operator_id: UUID
) -> None:
    """No organization or organization row remains; only the preserved operator account."""
    for table in (
        "organizations", "memberships", "sandbox_documents", "sandbox_versions",
        "boards", "departments",
    ):
        cursor.execute(f"SELECT count(*) FROM public.{table}")
        assert cursor.fetchone() == (0,), table
    cursor.execute("SELECT id FROM public.users")
    assert cursor.fetchall() == [(admin_id,)]
    cursor.execute("SELECT id, user_id FROM public.platform_operators")
    assert cursor.fetchall() == [(operator_id, admin_id)]
