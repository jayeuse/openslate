"""Record-date sources of Board calendars and My calendar (BR57): access, limits, purges."""

from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.calendar_source_models import BoardCalendarSource
from app.systems.boards.calendar_source_router import router as source_router
from app.systems.boards.models import Board
from app.systems.manage.audit.listeners import REALTIME_INVALIDATION_KEY
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.execution import execute_lifecycle
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleOperation, LifecycleTargetType
from tests.boards.kanban_support import Source, record_source
from tests.boards.support import client, department_board, grant, guest, member, project_board
from tests.rbac.support import organization
from tests.sandbox_designs.fixtures import create_document

pytestmark = pytest.mark.integration


def _api(db: Session, actor: User) -> TestClient:
    return client(db, actor, source_router)


def _body(source: Source, field: str = "Quoted on") -> dict[str, str]:
    return {"module_id": str(source.module.id), "date_field_id": str(source.fields[field].id)}


def _add_field(db: Session, source: Source, name: str, kind: FieldType) -> Field:
    field = Field(org_id=source.module.org_id, module_id=source.module.id, name=name,
                  type=kind, position=len(source.fields), required=False, config={})
    db.add(field)
    db.flush()
    source.fields[name] = field
    return field


def test_board_managers_add_and_remove_sources_and_readers_list_them(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, writer, reader, outsider = member(db), member(db), member(db), member(db)
    board = project_board(db)
    grant(db, board, [manager], AccessLevel.MANAGE)
    grant(db, board, [writer], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    source = record_source(db, manager, writer, reader)
    _add_field(db, source, "Visit at", FieldType.DATETIME)
    db.commit()
    root = f"/api/boards/{board.id}/calendar-sources"

    assert _api(db, writer).post(root, json=_body(source)).status_code == 403
    assert _api(db, outsider).post(root, json=_body(source)).status_code == 404
    first = _api(db, manager).post(root, json=_body(source))
    assert first.status_code == 201, first.text
    assert first.headers["Location"] == f"{root}/{first.json()['id']}"
    assert first.json() == {
        "id": first.json()["id"], "module_id": str(source.module.id), "module_name": "Quotes",
        "department_id": str(source.department.id),
        "date_field_id": str(source.fields["Quoted on"].id), "field_name": "Quoted on",
        "field_type": "date", "position": 0,
    }
    second = _api(db, manager).post(root, json=_body(source, "Visit at"))
    assert second.status_code == 201, second.text
    assert (second.json()["field_type"], second.json()["position"]) == ("datetime", 1)

    listed = _api(db, reader).get(root)
    assert listed.status_code == 200, listed.text
    assert listed.headers["cache-control"] == "private, no-store"
    assert [item["field_name"] for item in listed.json()["items"]] == ["Quoted on", "Visit at"]
    assert _api(db, outsider).get(root).status_code == 404

    path = f"{root}/{first.json()['id']}"
    assert _api(db, writer).delete(path).status_code == 403
    assert _api(db, manager).delete(path).status_code == 204
    assert _api(db, manager).delete(path).status_code == 404
    assert [item["field_name"] for item in _api(db, reader).get(root).json()["items"]] == [
        "Visit at"
    ]


@pytest.mark.parametrize(
    ("case", "code"),
    [
        ("text_field", "calendar_source_unavailable"),
        ("field_of_another_module", "calendar_source_unavailable"),
        ("unreadable_module", "calendar_source_unavailable"),
        ("closed_field", "calendar_source_unavailable"),
        ("duplicate", "calendar_source_exists"),
        ("sixth", "calendar_source_limit"),
    ],
)
def test_a_source_needs_a_live_readable_date_field_and_room(
    integration_owner_db: Session, case: str, code: str
) -> None:
    db = integration_owner_db
    manager = member(db)
    board = project_board(db)
    grant(db, board, [manager], AccessLevel.MANAGE)
    source, other = record_source(db, manager), record_source(db, manager)
    hidden = record_source(db)
    for index in range(4):
        _add_field(db, source, f"Date {index}", FieldType.DATE)
    db.commit()
    root = f"/api/boards/{board.id}/calendar-sources"
    api = _api(db, manager)
    assert api.post(root, json=_body(source)).status_code == 201
    if case == "sixth":
        for index in range(4):
            assert api.post(root, json=_body(source, f"Date {index}")).status_code == 201
        body = _body(other)
    elif case == "closed_field":
        field = source.fields["Date 0"]
        field.is_deleted, field.deleted_at = True, datetime.now(UTC)
        db.commit()
        body = _body(source, "Date 0")
    else:
        body = {
            "text_field": _body(source, "Owner"),
            "field_of_another_module": {"module_id": str(source.module.id),
                                        "date_field_id": str(other.fields["Quoted on"].id)},
            "unreadable_module": _body(hidden),
            "duplicate": _body(source),
        }[case]

    refused = api.post(root, json=body)

    assert refused.status_code == 409, refused.text
    assert refused.json()["detail"]["code"] == code
    if case == "unreadable_module":
        assert str(hidden.module.id) not in refused.text and "Quotes" not in refused.text


def test_a_list_leaves_out_sources_whose_module_the_viewer_cannot_read(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager, reader = member(db), member(db)
    board = project_board(db)
    grant(db, board, [manager], AccessLevel.MANAGE)
    grant(db, board, [reader], AccessLevel.READ)
    shared, private = record_source(db, manager, reader), record_source(db, manager)
    db.commit()
    root = f"/api/boards/{board.id}/calendar-sources"
    _api(db, manager).post(root, json=_body(shared))
    hidden = _api(db, manager).post(root, json=_body(private)).json()

    seen = _api(db, reader).get(root)

    assert [item["module_id"] for item in seen.json()["items"]] == [str(shared.module.id)]
    for secret in (hidden["id"], str(private.module.id), str(private.fields["Quoted on"].id)):
        assert secret not in seen.text
    assert set(seen.json()) == {"items"}
    assert len(_api(db, manager).get(root).json()["items"]) == 2


def test_my_sources_are_mine_in_this_organization(integration_owner_db: Session) -> None:
    db = integration_owner_db
    me, other, capped = member(db), member(db), guest(db)
    source = record_source(db, me, other, capped)
    for index in range(5):
        _add_field(db, source, f"Date {index}", FieldType.DATE)
    db.commit()
    root = "/api/me/calendar-sources"
    mine = _api(db, me).post(root, json=_body(source))
    assert mine.status_code == 201, mine.text
    assert mine.headers["Location"] == f"{root}/{mine.json()['id']}"
    theirs = _api(db, other).post(root, json=_body(source))
    assert theirs.status_code == 201, theirs.text
    assert _api(db, capped).post(root, json=_body(source)).status_code == 201

    assert [item["id"] for item in _api(db, me).get(root).json()["items"]] == [mine.json()["id"]]
    assert _api(db, me).delete(f"{root}/{theirs.json()['id']}").status_code == 404
    for index in range(4):
        assert _api(db, me).post(root, json=_body(source, f"Date {index}")).status_code == 201
    over = _api(db, me).post(root, json=_body(source, "Date 4"))
    assert over.json()["detail"]["code"] == "calendar_source_limit"
    assert _api(db, me).delete(f"{root}/{mine.json()['id']}").status_code == 204
    assert len(_api(db, me).get(root).json()["items"]) == 4
    assert len(_api(db, other).get(root).json()["items"]) == 1


def test_board_sources_invalidate_their_board_and_personal_ones_publish_nothing(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    person = member(db)
    source = record_source(db, person)
    board = department_board(db, source.department)
    db.commit()
    db.info.pop(REALTIME_INVALIDATION_KEY, None)
    field = source.fields["Quoted on"]
    on_board = BoardCalendarSource(org_id=board.org_id, board_id=board.id,
                                   module_id=source.module.id, date_field_id=field.id,
                                   position=0, created_by=person.id)
    personal = BoardCalendarSource(org_id=board.org_id, user_id=person.id,
                                   module_id=source.module.id, date_field_id=field.id,
                                   position=0, created_by=person.id)
    db.add_all((on_board, personal))
    db.flush()

    departments = {
        row.entity_id: row.department_id
        for row in db.scalars(select(AuditLog).where(
            AuditLog.entity_type == "board_calendar_sources",
            AuditLog.action == AuditAction.CREATE,
        ))
    }
    assert departments == {on_board.id: board.department_id, personal.id: None}
    payloads = [
        event.to_payload() for event in db.info.get(REALTIME_INVALIDATION_KEY, [])
        if event.entity == "board_calendar_sources"
    ]
    assert payloads == [{"board_id": str(board.id), "entity": "board_calendar_sources"}]


@pytest.mark.parametrize(
    "target",
    [LifecycleTargetType.FIELD, LifecycleTargetType.MODULE, LifecycleTargetType.DEPARTMENT],
)
def test_source_purges_list_and_remove_calendar_sources_without_blocking(
    integration_owner_db: Session, target: LifecycleTargetType
) -> None:
    db = integration_owner_db
    create_document(db, organization(db))
    person = member(db)
    source, kept = record_source(db), record_source(db)
    elsewhere, own = project_board(db), department_board(db, source.department)
    field = source.fields["Quoted on"]

    def add(owner: dict[str, UUID], of: Source = source) -> BoardCalendarSource:
        row = BoardCalendarSource(org_id=elsewhere.org_id, module_id=of.module.id,
                                  date_field_id=of.fields["Quoted on"].id, position=0,
                                  created_by=person.id, **owner)
        db.add(row)
        db.flush()
        return row

    removed = [add({"board_id": elsewhere.id}), add({"user_id": person.id}),
               add({"board_id": own.id})]
    survivor = add({"board_id": elsewhere.id}, kept)
    timestamp = datetime.now(UTC)
    closed: dict[LifecycleTargetType, list[Any]] = {
        LifecycleTargetType.FIELD: [field],
        LifecycleTargetType.MODULE: [source.record, source.module],
        LifecycleTargetType.DEPARTMENT: [source.record, source.module, source.department],
    }
    for row in closed[target]:
        row.is_deleted, row.deleted_at = True, timestamp
    db.commit()
    target_id: Callable[[], UUID] = {
        LifecycleTargetType.FIELD: lambda: field.id,
        LifecycleTargetType.MODULE: lambda: source.module.id,
        LifecycleTargetType.DEPARTMENT: lambda: source.department.id,
    }[target]

    plan = plan_lifecycle(db, target, target_id(), LifecycleOperation.PURGE, None)

    assert not plan.blockers
    listed = [row.entity_id for row in plan.rows if row.entity_type == "board_calendar_sources"]
    assert sorted(listed) == sorted(row.id for row in removed)
    execute_lifecycle(db, plan)
    db.expire_all()
    assert [db.get(BoardCalendarSource, row.id) for row in removed] == [None, None, None]
    assert db.get(BoardCalendarSource, survivor.id) is not None
    assert db.get(Board, elsewhere.id) is not None
