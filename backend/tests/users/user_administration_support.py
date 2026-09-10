import os
from collections.abc import Generator
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import text
from uuid6 import uuid7

from tests.conftest import guarded_create_engine as create_engine

TEST_DATABASE_URL = os.getenv("TEST_DATABASE_URL")
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        TEST_DATABASE_URL is None,
        reason="Set TEST_DATABASE_URL to run PostgreSQL integration tests",
    ),
]


def _guard_database(database_url: str) -> None:
    from tests.conftest import _guard_integration_database

    _guard_integration_database(database_url)


def _owner_database_url() -> str:
    database_url = os.getenv("MIGRATION_DATABASE_URL")
    if database_url is None:
        raise RuntimeError("MIGRATION_DATABASE_URL is required for owner fixture setup")
    _guard_database(database_url)
    return database_url


class _AdminFixture:
    def __init__(self) -> None:
        self.engine = create_engine(_owner_database_url(), pool_size=5)
        self.admin_role_id: UUID | None = None
        self.member_role_id: UUID | None = None
        self.assignment_role_id: UUID = uuid7()
        self.created_role_ids: list[UUID] = []
        self.user_ids: list[UUID] = [uuid7(), uuid7(), uuid7(), uuid7()]
        self.admin_snapshots: list[dict[str, Any]] = []

    def seed(self) -> None:
        admin_id, target_one, target_two, assignment_user = self.user_ids
        with self.engine.begin() as connection:
            roles = connection.execute(
                text(
                    "SELECT id, role FROM public.roles "
                    "WHERE role IN ('admin', 'member') AND is_deleted = false"
                )
            ).mappings()
            role_ids = {row["role"]: row["id"] for row in roles}
            for role_name in ("admin", "member"):
                role_id = role_ids.get(role_name)
                if role_id is None:
                    role_id = uuid7()
                    connection.execute(
                        text(
                            "INSERT INTO public.roles (id, role, permissions) "
                            "VALUES (:id, :role, '{}'::jsonb)"
                        ),
                        {"id": role_id, "role": role_name},
                    )
                    self.created_role_ids.append(role_id)
                if role_name == "admin":
                    self.admin_role_id = role_id
                else:
                    self.member_role_id = role_id

            connection.execute(
                text(
                    "INSERT INTO public.roles (id, role, permissions) "
                    "VALUES (:id, :role, '{}'::jsonb)"
                ),
                {"id": self.assignment_role_id, "role": f"red-lock-role-{uuid7().hex[:12]}"},
            )
            self.created_role_ids.append(self.assignment_role_id)

            self.admin_snapshots = [
                dict(row)
                for row in connection.execute(
                    text(
                        "SELECT id, status, is_deleted, deleted_at, role_id "
                        "FROM public.users WHERE role_id = :role_id"
                    ),
                    {"role_id": self.admin_role_id},
                ).mappings()
            ]
            connection.execute(
                text(
                    "UPDATE public.users SET status = 'disabled' "
                    "WHERE role_id = :role_id AND is_deleted = false"
                ),
                {"role_id": self.admin_role_id},
            )

            for user_id, email in (
                (admin_id, f"admin-{admin_id}@example.com"),
                (target_one, f"target-one-{target_one}@example.com"),
                (target_two, f"target-two-{target_two}@example.com"),
                (assignment_user, f"assignment-{assignment_user}@example.com"),
            ):
                connection.execute(
                    text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
                    {"id": user_id, "email": email},
                )
            connection.execute(
                text(
                    "UPDATE public.users SET status = 'active', is_deleted = false, "
                    "deleted_at = NULL, role_id = :role_id "
                    "WHERE id IN (:admin_id, :target_one, :target_two)"
                ),
                {
                    "role_id": self.admin_role_id,
                    "admin_id": admin_id,
                    "target_one": target_one,
                    "target_two": target_two,
                },
            )
            connection.execute(
                text("UPDATE public.users SET role_id = :role_id WHERE id = :user_id"),
                {"role_id": self.member_role_id, "user_id": self.user_ids[3]},
            )

    def cleanup(self) -> None:
        try:
            with self.engine.begin() as connection:
                for row in self.admin_snapshots:
                    connection.execute(
                        text(
                            "UPDATE public.users SET status = :status, is_deleted = :is_deleted, "
                            "deleted_at = :deleted_at, role_id = :role_id WHERE id = :id"
                        ),
                        row,
                    )
                connection.execute(
                    text(
                        "DELETE FROM auth.users "
                        "WHERE id IN (:admin_id, :target_one, :target_two, :assignment_user)"
                    ),
                    {
                        "admin_id": self.user_ids[0],
                        "target_one": self.user_ids[1],
                        "target_two": self.user_ids[2],
                        "assignment_user": self.user_ids[3],
                    },
                )
                for role_id in self.created_role_ids:
                    connection.execute(
                        text("DELETE FROM public.roles WHERE id = :id"),
                        {"id": role_id},
                    )
        finally:
            self.engine.dispose()


@pytest.fixture
def admin_fixture() -> Generator[_AdminFixture, None, None]:
    fixture = _AdminFixture()
    try:
        fixture.seed()
        yield fixture
    finally:
        fixture.cleanup()
