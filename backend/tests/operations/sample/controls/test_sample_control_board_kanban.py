"""The planned Kanban controls run against the real Board routes and PostgreSQL."""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from secrets import token_urlsafe
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.attachment_router import router as attachment_router
from app.systems.boards.calendar_source_router import router as source_router
from app.systems.boards.cross_board_occurrence_router import router as occurrence_router
from app.systems.boards.due_card_router import router as due_router
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.record_link_router import router as record_link_router
from app.systems.boards.router import router as boards_router
from app.systems.platform.files import board_router as board_files
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import transfer_slot
from app.systems.platform.files.storage import get_storage
from operations.sample.client import SampleClient
from operations.sample.controls.board_kanban import KANBAN_ROUTES
from operations.sample.controls.boards import execute_board_control, plan_board_controls
from operations.sample.packs.registry import get_pack
from operations.sample.phases.actions import PhaseExecutionContext
from operations.sample.scenario import build_dataset
from operations.sample.verification.route_coverage import read_route_evidence
from tests.boards.kanban_support import ROUTERS as KANBAN_ROUTERS
from tests.boards.kanban_support import record_source
from tests.boards.provider_accounts import create_password_account
from tests.boards.support import grant, member, project_board
from tests.conftest import create_member
from tests.files.test_integration import Store
from tests.organization_scope_support import scoped_override
from tests.rbac.support import organization

pytestmark = pytest.mark.integration


def _api(db: Session, actor: User, store: Store) -> TestClient:
    app = FastAPI()
    # main.py order: the fixed /boards/occurrences and /boards/cards/due paths first.
    routers = (occurrence_router, due_router, source_router, record_link_router,
               *KANBAN_ROUTERS, attachment_router, board_files.router, boards_router)  # fmt: skip
    for router in routers:
        app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = scoped_override(lambda: actor)
    app.dependency_overrides[get_storage] = lambda: store

    @app.middleware("http")
    async def admitted(request, call_next):
        with transfer_slot() as lease:
            request.state.file_transfer_lease = lease
            response = await call_next(request)
        response.headers["X-Request-ID"] = str(uuid4())
        return response

    return TestClient(app)


def _client(api: TestClient, journal: Path) -> SampleClient:
    def forward(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/auth/login":
            return httpx.Response(200, json={"ok": True}, headers=[
                ("Set-Cookie", "openslate_csrf=fixture; Path=/"),
                ("Set-Cookie", "openslate_access=fixture; Path=/; HttpOnly"),
            ])  # fmt: skip
        headers = {key: value for key, value in request.headers.items() if key != "host"}
        response = api.request(request.method, str(request.url), content=request.content,
                               headers=headers)  # fmt: skip
        return httpx.Response(
            response.status_code, headers=response.headers, content=response.content
        )

    client = SampleClient("http://testserver", "http://localhost:3000", journal,
                          transport=httpx.MockTransport(forward))  # fmt: skip
    assert client.login("fixture@example.test", "fixture-only").status_code == 200
    return client


def _admin(db: Session, password: str) -> User:
    user_id = uuid7()
    email = f"kanban-admin-{user_id.hex}@example.test"
    actor, _ = create_member(
        db, organization(db), id=user_id, email=email, username=f"kanban_{user_id.hex[:12]}",
        supabase_user_id=create_password_account(db, email=email, password=password),
        status="active", role="admin",
    )  # fmt: skip
    return actor


def test_kanban_controls_cover_every_board_kanban_route_and_leave_no_card_content(
    integration_owner_db: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    monkeypatch.setattr(board_files, "get_settings",
                        lambda: SimpleNamespace(lifecycle_purge_enabled=True))  # fmt: skip
    downloads: list[object] = []
    monkeypatch.setattr("app.systems.boards.attachment_router.append_committed_security_event",
                        lambda event, **_kwargs: downloads.append(event))  # fmt: skip
    dataset = build_dataset("small", 42, date(2026, 10, 1), organization=get_pack("harbor"))
    kanban = [action for action in plan_board_controls(dataset)
              if str(action.values["operation"]).startswith("kanban_")]  # fmt: skip
    values = kanban[0].values
    password = token_urlsafe(18)
    manager, admin = member(db), _admin(db, password)
    board = project_board(db)
    grant(db, board, [manager], AccessLevel.MANAGE)
    source = record_source(db, manager)
    event = BoardEvent(
        org_id=board.org_id, board_id=board.id, author_id=manager.id, title="Crane review",
        all_day=True, timezone_name="UTC",
        start_date=dataset.anchor_date + timedelta(days=14),
        end_date=dataset.anchor_date + timedelta(days=14),
    )  # fmt: skip
    db.add(event)
    db.commit()
    store = Store(db)
    journals = {"manager": tmp_path / "manager.jsonl", "admin": tmp_path / "admin.jsonl"}
    manager_key = kanban[0].actor_key
    context = PhaseExecutionContext(
        clients={manager_key: _client(_api(db, manager, store), journals["manager"]),
                 "admin": _client(_api(db, admin, store), journals["admin"])},
        user_ids={manager_key: str(manager.id), "admin": str(admin.id)},
        group_ids={}, department_ids={}, module_ids={}, field_ids={},
        mappings={
            "control_boards": {"control:board": str(board.id)},
            "control_events": {"control:event": str(event.id)},
            "record": {str(values["record_key"]): str(source.record.id)},
            "modules": {str(values["module_key"]): str(source.module.id)},
            "fields": {str(values["field_key"]): str(source.fields["Quoted on"].id)},
        },
        admin_password=password,
    )  # fmt: skip

    results = [execute_board_control(action, dataset, context) for action in kanban]

    assert [len(result["request_evidence"]) for result in results] == [12, 12, 6, 3]
    for action, result in zip(kanban, results, strict=True):
        assert {row["status_code"] for row in result["request_evidence"]} == {
            action.expected_status
        }
    covered = {
        (row["method"], row["path"])
        for journal in journals.values()
        for row in read_route_evidence(journal)["covered"]
    }
    assert covered >= KANBAN_ROUTES
    assert len(downloads) == 1
    # Every card file is purged, so the Board purge that ends the control run can proceed.
    db.expire_all()
    file = db.get(File, UUID(context.runtime_mappings["control_kanban"]["file"]))
    assert file is not None and file.state == "purged"
