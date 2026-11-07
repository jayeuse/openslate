"""DBI-12: every audit reader returns the same bytes on the plain and the partitioned table.

Only keys and indexes differ between the two schemas, so the same application code runs on
both. Each request goes through the real route as the runtime role, under row-level
security, before and after the upgrade.
"""

import os
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool
from uuid6 import uuid7

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core.database.session import AuditSession
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User, UserRole
from app.systems.boards.kanban_models import BoardCard
from app.systems.manage.audit.context import AUDIT_CONTEXT_KEY, AuditContext, set_audit_actor
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.sandbox.records.models import Record
from tests.boards.kanban_support import add_objective, add_stage
from tests.boards.support import board_group, project_board
from tests.conftest import alembic_heads, guarded_create_engine, membership_of
from tests.database_pool import dispose_process_engines
from tests.operations.migration_support import guarded_migration_environment, run_alembic
from tests.organization_scope_support import scoped_override
from tests.rbac.support import (
    _client,
    add_department,
    add_module,
    add_user,
    make_group_access,
    organization,
)

pytestmark = pytest.mark.integration

PREVIOUS = "4d8efe5fde6f"
SETTINGS = "/api/comms/settings/workspace"
SEARCH_WORD = "needle"
Reply = tuple[int, str, bytes]


@dataclass(frozen=True)
class _Request:
    label: str
    account: str
    path: str
    params: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class _World:
    admin: UUID
    manager: UUID
    member: UUID
    department: UUID
    record: UUID
    board: UUID
    card: UUID
    actor_rows: UUID
    request_id: UUID
    months: tuple[datetime, ...]
    row_of_each_month: tuple[UUID, ...]
    hidden_link: UUID


def _month(months_from_now: int) -> datetime:
    now = datetime.now(UTC)
    year, month = divmod(now.year * 12 + now.month - 1 + months_from_now, 12)
    return datetime(year, month + 1, 10, 12, tzinfo=UTC)


def _insert(db: Session, **values: Any) -> UUID:
    identity = values.setdefault("id", uuid7())
    db.connection().execute(AuditLog.__table__.insert().values(**values))
    return identity


def _seed(owner: Engine) -> _World:
    """Rows in three months and past the created months, for every filter that a reader has."""

    with AuditSession(bind=owner, expire_on_commit=False) as db:
        db.info[AUDIT_CONTEXT_KEY] = AuditContext(
            request_id=uuid7(), request_method="POST", request_path="/api/test/reader-matrix"
        )
        org = organization(db)
        admin = add_user(db, role=UserRole.ADMIN)
        manager, member = add_user(db), add_user(db)
        set_audit_actor(db, admin.id)
        department, hidden_department = add_department(db), add_department(db)
        module, hidden_module = add_module(db, department), add_module(db, hidden_department)
        make_group_access(db, [manager], department, level=AccessLevel.MANAGE)
        make_group_access(db, [member], department, module, level=AccessLevel.READ)
        record = Record(org_id=org.id, module_id=module.id, data={})
        hidden_record = Record(org_id=org.id, module_id=hidden_module.id, data={})
        db.add_all([record, hidden_record])
        db.flush()
        board = project_board(db)
        board_group(db, board, [member], AccessLevel.READ)
        stage = add_stage(db, board)
        card: BoardCard = add_objective(db, board, stage, "Reader matrix", 1)

        other = uuid7()
        db.connection().execute(
            WorkspaceProfile.__table__.insert().values(
                id=other, slug=f"other-{other}", display_name="Other", timezone="UTC",
                locale="en-US",
            )
        )
        request_id = uuid7()
        months = tuple(_month(step) for step in (-2, -1, 0, 5))
        rows = []
        for position, created_at in enumerate(months):
            common = {"org_id": org.id, "created_at": created_at}
            rows.append(
                _insert(
                    db,
                    **common,
                    performed_by=admin.id,
                    action=("create", "update", "delete", "update")[position],
                    entity_type="records",
                    entity_id=record.id,
                    department_id=department.id,
                    request_id=request_id,
                    request_method="PATCH",
                    request_path=f"/api/records/{position}",
                    actor_label="Admin",
                    after={"note": f"{SEARCH_WORD} {position}"},
                )
            )
            _insert(
                db,
                **common,
                performed_by=manager.id,
                action="create",
                entity_type="departments",
                entity_id=department.id,
                department_id=department.id,
                request_path=f"/api/departments/{position}",
                after={"name": "Same instant, so the UUID breaks the tie"},
            )
            _insert(db, **common, action="delete", entity_type="reports", entity_id=uuid7())
            _insert(db, org_id=other, created_at=created_at, action="create", entity_type="files")
            _insert(
                db,
                created_at=created_at,
                action="update",
                entity_type="users",
                entity_id=manager.id,
                after={"position": position},
            )
        hidden_link = _insert(
            db,
            org_id=org.id,
            created_at=months[2],
            action="delete",
            entity_type="relationship_edges",
            entity_id=uuid7(),
            department_id=department.id,
            before={
                "source_record_id": str(record.id),
                "target_record_id": str(hidden_record.id),
            },
        )
        db.commit()
        return _World(
            admin.id, manager.id, member.id, department.id, record.id, board.id, card.id,
            admin.id, request_id, months, tuple(rows), hidden_link,
        )


def _requests(world: _World, settings_entry: str) -> list[_Request]:
    root = "/api/audit-logs"
    first, second = world.months[0], world.months[2]
    department = ("department_id", str(world.department))
    requests = [
        _Request("list", "admin", root),
        _Request("second page", "admin", root, (("limit", "3"), ("offset", "3"))),
    ]
    for field in ("action", "created_at", "entity_type", "request_path"):
        for order in ("asc", "desc"):
            requests.append(
                _Request(
                    f"sort {field} {order}",
                    "admin",
                    root,
                    (("sort_by", field), ("sort_order", order)),
                )
            )
    for name, value in (
        ("performed_by", str(world.admin)),
        ("request_id", str(world.request_id)),
        ("reference", str(world.request_id)[-8:]),
        ("reference", str(world.request_id)),
        ("entity_id", str(world.record)),
        ("entity_type", "records"),
        ("department_id", str(world.department)),
        ("action", "delete"),
        ("created_after", first.isoformat()),
        ("created_before", second.isoformat()),
        ("search", SEARCH_WORD),
    ):
        requests.append(_Request(f"filter {name} {len(value)}", "admin", root, ((name, value),)))
    requests += [
        _Request(
            "date range",
            "admin",
            root,
            (("created_after", first.isoformat()), ("created_before", second.isoformat())),
        ),
        _Request("options", "admin", f"{root}/options"),
        _Request("department options", "admin", f"{root}/options", (department,)),
        _Request("options search", "admin", f"{root}/options", (("search", "rec"),)),
        _Request("export", "admin", f"{root}/export"),
        _Request("export filter", "admin", f"{root}/export", (("action", "update"),)),
        _Request("manager list", "manager", root, (department,)),
        _Request("manager filter", "manager", root, (department, ("action", "delete"))),
        _Request("manager options", "manager", f"{root}/options", (department,)),
        _Request("member history", "member", root, (("entity_id", str(world.record)),)),
        _Request("board activity", "member", f"/api/boards/{world.board}/activity"),
        _Request(
            "card activity",
            "member",
            f"/api/boards/{world.board}/cards/{world.card}/activity",
        ),
        _Request("settings history", "admin", f"{SETTINGS}/history"),
        _Request("settings entry", "admin", f"{SETTINGS}/history/{settings_entry}"),
    ]
    for position, row in enumerate(world.row_of_each_month):
        requests.append(_Request(f"detail {position}", "admin", f"{root}/{row}"))
    return requests


def _api(api_app: FastAPI, db: Session, user_id: UUID) -> TestClient:
    """A client of the whole application as this person, on a runtime session."""

    user = db.get_one(User, user_id)
    membership = membership_of(db, user_id)
    set_audit_actor(db, user_id)
    client = _client(api_app, user, db)
    # The Comms routes read the account and the membership through their own dependencies.
    api_app.dependency_overrides[get_account_user] = scoped_override(lambda: user)
    api_app.dependency_overrides[get_current_membership] = lambda: membership
    return client


def _change_settings(api_app: FastAPI, runtime: Engine, world: _World) -> str:
    """One real settings change, because history replays what the writer stored."""

    with AuditSession(bind=runtime, expire_on_commit=False) as db:
        api = _api(api_app, db, world.admin)
        current = api.get(SETTINGS)
        assert current.status_code == 200, current.text
        changed = api.patch(
            SETTINGS,
            json={"slow_mode_seconds": 5},
            headers={"If-Match": current.headers["etag"]},
        )
        assert changed.status_code == 200, changed.text
        history = api.get(f"{SETTINGS}/history")
        assert history.status_code == 200, history.text
        return str(history.json()["items"][0]["id"])


def _read_every_route(
    api_app: FastAPI, runtime: Engine, world: _World, requests: list[_Request]
) -> dict[str, Reply]:
    accounts = {"admin": world.admin, "manager": world.manager, "member": world.member}
    replies: dict[str, Reply] = {}
    for account, user_id in accounts.items():
        with AuditSession(bind=runtime, expire_on_commit=False) as db:
            api = _api(api_app, db, user_id)
            for request in requests:
                if request.account == account:
                    response = api.get(request.path, params=list(request.params))
                    replies[request.label] = (
                        response.status_code,
                        response.headers["content-type"],
                        response.content,
                    )
                    db.rollback()
    return replies


@pytest.fixture
def plain_schema() -> Iterator[tuple[dict[str, str], Engine, Engine]]:
    """Start at the plain table. The rows that a test commits leave with `downgrade base`."""

    environment = guarded_migration_environment()
    [head] = alembic_heads()
    dispose_process_engines()
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"], poolclass=NullPool)
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"], poolclass=NullPool)
    run_alembic(environment, "downgrade", PREVIOUS)
    try:
        yield environment, owner, runtime
    finally:
        run_alembic(environment, "downgrade", "base")
        run_alembic(environment, "upgrade", head)
        owner.dispose()
        runtime.dispose()


def test_every_audit_reader_returns_the_same_bytes_after_the_upgrade_dbi12(
    plain_schema: tuple[dict[str, str], Engine, Engine],
) -> None:
    from app.main import create_app

    environment, owner, runtime = plain_schema
    [head] = alembic_heads()
    api_app = create_app()
    world = _seed(owner)
    settings_entry = _change_settings(api_app, runtime, world)
    requests = _requests(world, settings_entry)

    before = _read_every_route(api_app, runtime, world, requests)

    assert len(before) == len(requests)
    empty = [
        label
        for label, (status, kind, body) in before.items()
        if status != 200 or body in (b"", b"[]") or b'"items":[]' in body
    ]
    assert empty == []
    assert str(world.hidden_link).encode() in before["list"][2]
    assert str(world.hidden_link).encode() not in before["manager list"][2]

    run_alembic(environment, "upgrade", head)
    dispose_process_engines()
    with owner.connect() as connection:
        homes = connection.scalars(
            text(
                "SELECT DISTINCT tableoid::regclass::text FROM public.audit_logs "
                "WHERE id = ANY(:ids)"
            ),
            {"ids": list(world.row_of_each_month)},
        )
        assert len(list(homes)) == 4

    after = _read_every_route(api_app, runtime, world, requests)

    assert [label for label in before if before[label] != after[label]] == []
