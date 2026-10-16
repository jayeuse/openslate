"""Owned PostgreSQL fixtures for registered relationship API tests."""

from __future__ import annotations

import os
from collections.abc import Generator, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from fastapi import Request
from fastapi.testclient import TestClient
from sqlalchemy import bindparam, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.config import get_settings
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.core.middleware.request_context import get_request_context
from app.systems.access.users.models import User
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext, set_audit_actor
from tests.conftest import (
    _assert_alembic_head,
    _guard_integration_database,
    create_member,
    create_organization,
)
from tests.conftest import guarded_create_engine as create_engine
from tests.organization_scope_support import scoped_override
from tests.route_app_support import route_app


@dataclass(frozen=True, slots=True)
class RelationshipGraph:
    department_id: UUID
    other_department_id: UUID
    source_module_id: UUID
    target_module_id: UUID
    cross_module_id: UUID
    field_id: UUID
    cross_field_id: UUID
    self_field_id: UUID
    source_id: UUID
    target_id: UUID
    replacement_id: UUID
    cross_target_id: UUID
    cross_replacement_id: UUID

    @property
    def ids(self) -> set[UUID]:
        return {
            self.department_id,
            self.other_department_id,
            self.source_module_id,
            self.target_module_id,
            self.cross_module_id,
            self.field_id,
            self.cross_field_id,
            self.self_field_id,
            self.source_id,
            self.target_id,
            self.replacement_id,
            self.cross_target_id,
            self.cross_replacement_id,
        }


def _urls() -> tuple[str, str]:
    settings = get_settings()
    runtime_url = settings.database_url
    owner_url = os.getenv("MIGRATION_DATABASE_URL")
    if owner_url is None:
        pytest.skip("MIGRATION_DATABASE_URL is required for owned relationship fixtures")
    _guard_integration_database(runtime_url)
    _guard_integration_database(owner_url)
    return runtime_url, owner_url


def _preflight(runtime_url: str, owner_url: str) -> None:
    runtime_engine = create_engine(runtime_url)
    owner_engine = create_engine(owner_url)
    try:
        with runtime_engine.connect() as connection:
            if connection.scalar(text("SELECT current_user")) != "openslate_runtime":
                raise RuntimeError("Relationship API tests require the openslate_runtime role")
            _assert_alembic_head(connection)
            connection.rollback()
        with owner_engine.connect() as connection:
            _assert_alembic_head(connection)
            connection.rollback()
    finally:
        runtime_engine.dispose()
        owner_engine.dispose()


def _load_user(runtime_engine: Engine, actor_id: UUID) -> User:
    with Session(runtime_engine) as database:
        actor = database.scalar(select(User).where(User.id == actor_id))
        if actor is None:
            raise RuntimeError("The owned relationship user could not be loaded")
        database.expunge_all()
        return actor


class RelationshipHTTPFixture:
    """Seeds an isolated graph and gives each API request a fresh session."""

    def __init__(self, runtime_url: str, owner_url: str) -> None:
        self.runtime_engine = create_engine(runtime_url, pool_size=4)
        self.owner_engine = create_engine(owner_url, pool_size=4)
        self.app = route_app()
        self.actor_id = uuid7()
        self.member_id = uuid7()
        self.guest_id = uuid7()
        self.writer_id = uuid7()
        self.group_id = uuid7()
        self.org_id = uuid7()
        self.member: User | None = None
        self.guest: User | None = None
        self.writer: User | None = None
        self.graph: RelationshipGraph | None = None
        self._all_ids: set[UUID] = {self.actor_id, self.member_id, self.guest_id, self.writer_id}
        try:
            self.actor = self._seed()
        except BaseException:
            self.cleanup()
            raise
        self._install_overrides(self.actor)

    def _seed(self) -> User:
        graph = RelationshipGraph(
            department_id=uuid7(),
            other_department_id=uuid7(),
            source_module_id=uuid7(),
            target_module_id=uuid7(),
            cross_module_id=uuid7(),
            field_id=uuid7(),
            cross_field_id=uuid7(),
            self_field_id=uuid7(),
            source_id=uuid7(),
            target_id=uuid7(),
            replacement_id=uuid7(),
            cross_target_id=uuid7(),
            cross_replacement_id=uuid7(),
        )
        self.graph = graph
        self._all_ids.update(graph.ids)
        with Session(self.owner_engine) as db:
            organization = create_organization(db, id=self.org_id)
            connection = db.connection()
            prefix = graph.department_id.hex[:12]
            email = f"rel-http-{prefix}@example.com"
            create_member(db, organization, "admin", id=self.actor_id,
                          email=email, username=f"rel_http_{prefix}", status="active")
            for user_id, label in ((self.member_id, "member"), (self.writer_id, "writer")):
                create_member(db, organization, "member", id=user_id,
                              email=f"rel-http-{label}-{prefix}@example.com",
                              username=f"rel_http_{label}_{prefix}", status="active")
            self._insert_graph(connection, graph)
            # A guest whose group writes the whole department still only reads it.
            # The writer shares that group, so it writes the department and has no
            # access to the other department.
            create_member(db, organization, "guest", id=self.guest_id,
                          email=f"rel-http-guest-{prefix}@example.com",
                          username=f"rel_http_guest_{prefix}", status="active",
                          sponsor_user_id=self.member_id,
                          expires_at=datetime.now(UTC) + timedelta(days=30))
            connection.execute(
                text("INSERT INTO public.groups (org_id, id, name) VALUES (:org_id, :id, :name)"),
                {"org_id": self.org_id, "id": self.group_id, "name": f"Rel HTTP guests {prefix}"},
            )
            connection.execute(
                text(
                    "INSERT INTO public.group_members (org_id, id, group_id, user_id) "
                    "VALUES (:org_id, :id, :group_id, :user_id), "
                    "(:org_id, :writer_row, :group_id, :writer_id)"
                ),
                {
                    "org_id": self.org_id,
                    "id": uuid7(),
                    "group_id": self.group_id,
                    "user_id": self.guest_id,
                    "writer_row": uuid7(),
                    "writer_id": self.writer_id,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO public.group_access (org_id, id, group_id, department_id, level) "
                    "VALUES (:org_id, :id, :group_id, :department_id, 'write')"
                ),
                {"org_id": self.org_id, "id": uuid7(), "group_id": self.group_id,
                 "department_id": graph.department_id},
            )
            db.commit()
        self.member = _load_user(self.runtime_engine, self.member_id)
        self.guest = _load_user(self.runtime_engine, self.guest_id)
        self.writer = _load_user(self.runtime_engine, self.writer_id)
        return _load_user(self.runtime_engine, self.actor_id)

    def _insert_graph(self, connection: Any, graph: RelationshipGraph) -> None:
        connection.execute(
            text(
                "INSERT INTO public.departments (org_id, id, department_name, is_deleted) "
                "VALUES (:org_id, :id, :name, false), (:org_id, :other_id, :other_name, false)"
            ),
            {
                "org_id": self.org_id,
                "id": graph.department_id,
                "name": f"Rel HTTP {graph.department_id.hex[:12]}",
                "other_id": graph.other_department_id,
                "other_name": f"Rel HTTP Other {graph.other_department_id.hex[:12]}",
            },
        )
        connection.execute(
            text(
                "INSERT INTO public.modules "
                "(org_id, id, department_id, module_name, is_deleted) VALUES "
                "(:org_id, :source_id, :department_id, :source_name, false), "
                "(:org_id, :target_id, :department_id, :target_name, false), "
                "(:org_id, :cross_id, :other_department_id, :cross_name, false)"
            ),
            {
                "org_id": self.org_id,
                "source_id": graph.source_module_id,
                "target_id": graph.target_module_id,
                "cross_id": graph.cross_module_id,
                "department_id": graph.department_id,
                "other_department_id": graph.other_department_id,
                "source_name": f"Rel Source {graph.source_module_id.hex[:12]}",
                "target_name": f"Rel Target {graph.target_module_id.hex[:12]}",
                "cross_name": f"Rel Cross {graph.cross_module_id.hex[:12]}",
            },
        )
        connection.execute(
            text(
                "INSERT INTO public.fields "
                "(org_id, id, module_id, name, type, required, position, config, "
                "relationship_target_module_id, relationship_multiple_targets, "
                "relationship_multiple_sources, is_deleted) VALUES "
                "(:org_id, :field_id, :source_id, :field_name, 'relationship', false, 0, "
                "'{}'::jsonb, "
                ":target_id, false, false, false), "
                "(:org_id, :cross_field_id, :source_id, :cross_field_name, 'relationship', "
                "false, 1, "
                "'{}'::jsonb, :cross_id, false, false, false), "
                "(:org_id, :self_field_id, :source_id, :self_field_name, 'relationship', false, 2, "
                "'{}'::jsonb, :source_id, false, false, false)"
            ),
            {
                "org_id": self.org_id,
                "field_id": graph.field_id,
                "cross_field_id": graph.cross_field_id,
                "self_field_id": graph.self_field_id,
                "source_id": graph.source_module_id,
                "target_id": graph.target_module_id,
                "cross_id": graph.cross_module_id,
                "field_name": f"Related {graph.field_id.hex[:12]}",
                "cross_field_name": f"Cross {graph.cross_field_id.hex[:12]}",
                "self_field_name": f"Self {graph.self_field_id.hex[:12]}",
            },
        )
        connection.execute(
            text(
                "INSERT INTO public.records (org_id, id, module_id, data, is_deleted) VALUES "
                "(:org_id, :source_id, :source_module, '{}'::jsonb, false), "
                "(:org_id, :target_id, :target_module, '{}'::jsonb, false), "
                "(:org_id, :replacement_id, :target_module, '{}'::jsonb, false), "
                "(:org_id, :cross_target_id, :cross_module, '{}'::jsonb, false), "
                "(:org_id, :cross_replacement_id, :cross_module, '{}'::jsonb, false)"
            ),
            {
                "org_id": self.org_id,
                "source_id": graph.source_id,
                "target_id": graph.target_id,
                "replacement_id": graph.replacement_id,
                "cross_target_id": graph.cross_target_id,
                "cross_replacement_id": graph.cross_replacement_id,
                "source_module": graph.source_module_id,
                "target_module": graph.target_module_id,
                "cross_module": graph.cross_module_id,
            },
        )

    def _install_overrides(self, actor: User) -> None:
        self.app.dependency_overrides[get_current_user] = scoped_override(
            lambda: actor, org_id=self.org_id
        )
        self.app.dependency_overrides[get_db] = self._request_database

    def _request_database(self, request: Request) -> Iterator[Session]:
        request_context = get_request_context(request)
        database = AuditSession(bind=self.runtime_engine)
        database.info[AUDIT_CONTEXT_KEY] = AuditContext(
            performed_by=self.actor_id,
            request_id=request_context.request_id,
            request_method=request.method,
            request_path=request.url.path,
        )
        set_audit_actor(database, self.actor_id)
        try:
            yield database
        finally:
            database.close()

    def client(self, actor: User | None = None) -> TestClient:
        if actor is not None:
            self._install_overrides(actor)
        return TestClient(self.app)

    def archive_target(self, record_id: UUID | None = None) -> None:
        assert self.graph is not None
        with self.owner_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE public.records SET is_deleted = true, deleted_at = now() WHERE id = :id"
                ),
                {"id": record_id or self.graph.target_id},
            )

    def restore_target(self, record_id: UUID | None = None) -> None:
        assert self.graph is not None
        with self.owner_engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE public.records SET is_deleted = false, deleted_at = NULL WHERE id = :id"
                ),
                {"id": record_id or self.graph.target_id},
            )

    def active_edge_ids(self) -> set[UUID]:
        assert self.graph is not None
        with self.owner_engine.connect() as connection:
            return set(
                connection.execute(
                    text(
                        "SELECT id FROM public.relationship_edges "
                        "WHERE field_id IN (:field_id, :cross_field_id, :self_field_id) "
                        "AND is_deleted = false"
                    ),
                    {
                        "field_id": self.graph.field_id,
                        "cross_field_id": self.graph.cross_field_id,
                        "self_field_id": self.graph.self_field_id,
                    },
                ).scalars()
            )

    def cleanup(self) -> None:
        self.app.dependency_overrides.clear()
        self.runtime_engine.dispose()
        try:
            with self.owner_engine.begin() as connection:
                ids = list(self._all_ids)
                user_ids = [self.actor_id, self.member_id, self.guest_id, self.writer_id]
                for table in ("group_access", "group_members"):
                    connection.execute(
                        text(f"DELETE FROM public.{table} WHERE group_id = :group_id"),
                        {"group_id": self.group_id},
                    )
                connection.execute(
                    text("DELETE FROM public.groups WHERE id = :group_id"),
                    {"group_id": self.group_id},
                )
                if ids:
                    expanded = bindparam("ids", expanding=True)
                    expanded_user_ids = bindparam("user_ids", expanding=True)
                    connection.execute(
                        text(
                            "DELETE FROM public.relationship_edges "
                            "WHERE field_id IN (:field_id, :cross_field_id, :self_field_id)"
                        ),
                        {
                            "field_id": self.graph.field_id if self.graph else None,
                            "cross_field_id": self.graph.cross_field_id if self.graph else None,
                            "self_field_id": self.graph.self_field_id if self.graph else None,
                        },
                    )
                    connection.execute(
                        text(
                            "DELETE FROM public.audit_logs "
                            "WHERE entity_id IN :ids OR performed_by IN :user_ids "
                            "OR org_id = :org_id"
                        ).bindparams(expanded, expanded_user_ids),
                        {"ids": ids, "user_ids": user_ids, "org_id": self.org_id},
                    )
                    for table in ("records", "fields", "modules", "departments"):
                        connection.execute(
                            text(f"DELETE FROM public.{table} WHERE id IN :ids").bindparams(
                                expanded
                            ),
                            {"ids": ids},
                        )
                connection.execute(
                    text("DELETE FROM public.memberships WHERE user_id IN :user_ids").bindparams(
                        bindparam("user_ids", expanding=True)
                    ),
                    {"user_ids": user_ids},
                )
                connection.execute(
                    text("DELETE FROM public.users WHERE id IN :user_ids").bindparams(
                        bindparam("user_ids", expanding=True)
                    ),
                    {"user_ids": user_ids},
                )
                connection.execute(
                    text("DELETE FROM public.organizations WHERE id = :id"), {"id": self.org_id}
                )
        finally:
            self.owner_engine.dispose()


@pytest.fixture
def relationship_http_fixture() -> Generator[RelationshipHTTPFixture, None, None]:
    runtime_url, owner_url = _urls()
    _preflight(runtime_url, owner_url)
    fixture = RelationshipHTTPFixture(runtime_url, owner_url)
    try:
        yield fixture
    finally:
        fixture.cleanup()
