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
