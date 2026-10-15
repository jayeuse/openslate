"""Owned widget-reference worlds and real session transport overrides for route tests."""

import os
from collections.abc import Iterator
from datetime import timedelta
from typing import Annotated
from uuid import UUID

import pytest
from fastapi import APIRouter, Depends, Request
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.core.base_model import utc_now
from app.core.config import get_settings
from app.core.database import get_db
from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.models import Board, BoardGroup
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext, set_audit_actor
from app.systems.openview.dashboards.models import Dashboard
from app.systems.sandbox.fields.models import Field, FieldType
from tests.boards.support import client as board_client
from tests.boards.support import grant, project_board
from tests.charts.chart_route_support import ChartWorld
from tests.conftest import _assert_alembic_head, guarded_create_engine
from tests.live_session_support import with_live_session
from tests.rbac.support import add_department, add_module, add_user, make_group_access
from tests.route_app_support import route_app


def client(db: Session, actor: User, *routers: APIRouter) -> TestClient:
    return with_live_session(board_client(db, actor, *routers), db, actor)


def managed_board(world: ChartWorld, *actor_names: str) -> Board:
    board = project_board(world.db)
    grant(world.db, board, [world.users[name] for name in actor_names], AccessLevel.MANAGE)
    world.db.commit()
    return board


class ReferenceRaceWorld:
    """Committed owned fixture; every HTTP request gets a constrained runtime AuditSession."""

    def __init__(self) -> None:
        self.runtime = guarded_create_engine(get_settings().database_url, pool_size=4)
        self.owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], pool_size=4)
        self.actors: dict[str, UUID] = {}
        self.sessions: dict[str, UUID] = {}
        self.charts: list[UUID] = []
        with self.runtime.connect() as connection:
            _assert_alembic_head(connection)
            if connection.scalar(text("SELECT current_user")) != "openslate_runtime":
                raise RuntimeError("Reference requests require the constrained runtime role")
        with self.owner.connect() as connection:
            _assert_alembic_head(connection)
        with AuditSession(self.owner) as db:
            department = add_department(db)
            other_department = add_department(db)
            module = add_module(db, department)
            field = Field(
                org_id=module.org_id,
                module_id=module.id, name="Label", type=FieldType.TEXT, position=0, config={}
            )
            db.add(field)
            admin = add_user(db, role="admin")
            member = add_user(db, role="member")
            access = make_group_access(db, [member], department, level=AccessLevel.MANAGE)
            board = project_board(db)
            db.add(BoardGroup(org_id=board.org_id, board_id=board.id,
                              group_id=access.group_id, level="manage"))
            dashboard = Dashboard(org_id=department.org_id, department_id=department.id,
                                  name="Race Dashboard " + uuid7().hex)
            db.add(dashboard)
            now = utc_now()
            for key, actor in (("admin", admin), ("member", member)):
                live = IdentitySession(
                    user_id=actor.id,
                    refresh_token_digest=uuid7().hex + uuid7().hex,
                    csrf_token_digest=uuid7().hex + uuid7().hex,
                    created_at=now,
                    refreshed_at=now,
                    expires_at=now + timedelta(hours=1),
                )
                db.add(live)
                db.flush()
                self.actors[key], self.sessions[key] = actor.id, live.id
            self.department_id, self.other_department_id = department.id, other_department.id
            self.organization_id = department.org_id
            self.module_id, self.field_id = module.id, field.id
            self.group_id, self.board_id, self.dashboard_id = (
                access.group_id,
                board.id,
                dashboard.id,
            )
            db.commit()
        self.app = route_app()

        def database(request: Request):
            with AuditSession(self.runtime) as db:
                db.info[AUDIT_CONTEXT_KEY] = AuditContext(
                    request_id=uuid7(), request_method=request.method, request_path=request.url.path
                )
                yield db

        def identity(request: Request, db: Annotated[Session, Depends(get_db)]) -> CurrentIdentity:
            key = request.headers.get("x-reference-actor", "member")
            actor = db.get(User, self.actors[key])
            assert actor is not None
            set_audit_actor(db, actor.id)
            return CurrentIdentity(actor, self.sessions[key], False, False)

        self.app.dependency_overrides[get_db] = database
        self.app.dependency_overrides[get_current_identity] = identity
        with self.client("admin") as client:
            for name in ("First", "Second"):
                response = client.post(
                    "/api/charts",
                    json={
                        "module_id": str(self.module_id),
                        "name": name,
                        "chart_type": "bar",
                        "query": {
                            "module_id": str(self.module_id),
                            "definition": {"version": 1, "columns": []},
                            "mode": "groups",
                            "dimension": {"field_id": str(self.field_id), "expected_type": "text"},
                            "aggregation": "count",
                        },
                    },
                )
                if response.status_code != 201:
                    raise RuntimeError("Owned race Chart creation failed")
                self.charts.append(UUID(response.json()["id"]))

    def client(self, actor: str = "member") -> TestClient:
        return TestClient(self.app, headers={"x-reference-actor": actor})

    def attachment(self, client: TestClient, kind: str = "board", chart_ids=None):
        ids = self.charts[:1] if chart_ids is None else chart_ids
        specs = [
            {"widget_type": "chart", "chart_id": str(identifier), "config": None, "size": "S"}
            for identifier in ids
        ]
        if kind == "dashboard":
            return client.patch(
                f"/api/dashboards/{self.dashboard_id}", json={"revision": 1, "widgets": specs}
            )
        return client.post(
            f"/api/boards/{self.board_id}/widgets",
            json={
                "revision": 1,
                "widget": {
                    **specs[0],
                    "name": "Race widget",
                    "module_id": str(self.module_id),
                    "pinned": True,
                },
            },
        )

    def cleanup(self) -> None:
        # Only this committed fixture graph/actors; never global application-data cleanup.
        with self.owner.begin() as connection:
            entity_ids = {
                self.department_id,
                self.other_department_id,
                self.module_id,
                self.field_id,
                self.group_id,
                self.board_id,
                self.dashboard_id,
                *self.actors.values(),
                *self.sessions.values(),
                *self.charts,
            }
            for table, column, identifier in (
                ("group_members", "group_id", self.group_id),
                ("group_access", "group_id", self.group_id),
                ("board_groups", "board_id", self.board_id),
            ):
                entity_ids.update(
                    connection.scalars(
                        text(f"SELECT id FROM {table} WHERE {column} = :id"), {"id": identifier}
                    ).all()
                )
            connection.execute(
                text(
                    "DELETE FROM audit_logs WHERE performed_by = ANY(:actors) "
                    "OR entity_id = ANY(:ids)"
                ),
                {"actors": list(self.actors.values()), "ids": list(entity_ids)},
            )
            for table, column, ids in (
                ("board_widgets", "board_id", [self.board_id]),
                ("dashboard_widgets", "dashboard_id", [self.dashboard_id]),
                ("board_groups", "board_id", [self.board_id]),
                ("dashboards", "id", [self.dashboard_id]),
                ("boards", "id", [self.board_id]),
                ("charts", "module_id", [self.module_id]),
                ("group_access", "group_id", [self.group_id]),
                ("group_members", "group_id", [self.group_id]),
                ("groups", "id", [self.group_id]),
                ("identity_sessions", "id", list(self.sessions.values())),
                ("fields", "module_id", [self.module_id]),
                ("modules", "id", [self.module_id]),
                ("departments", "id", [self.department_id, self.other_department_id]),
                ("audit_logs", "performed_by", list(self.actors.values())),
                ("memberships", "user_id", list(self.actors.values())),
                ("users", "id", list(self.actors.values())),
                ("organizations", "id", [self.organization_id]),
            ):
                connection.execute(
                    text(f"DELETE FROM public.{table} WHERE {column} = ANY(:ids)"), {"ids": ids}
                )
        self.runtime.dispose()
        self.owner.dispose()


@pytest.fixture
def reference_race_world() -> Iterator[ReferenceRaceWorld]:
    world = ReferenceRaceWorld.__new__(ReferenceRaceWorld)
    try:
        world.__init__()
        yield world
    finally:
        if hasattr(world, "board_id"):
            world.cleanup()
        else:
            for name in ("runtime", "owner"):
                engine = getattr(world, name, None)
                if engine is not None:
                    engine.dispose()
