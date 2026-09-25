"""Board placement routes against runner-owned PostgreSQL."""

from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.users.models import Role, User
from app.systems.boards.models import Board, BoardGrant, BoardRecordPlacement, BoardStatus
from app.systems.boards.placement_router import router
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record

pytestmark = pytest.mark.integration


def _actor(db: Session, capabilities: dict[str, bool]) -> User:
    role = Role(role=f"board-placement-{uuid7().hex}", permissions=capabilities)
    db.add(role)
    db.flush()
    user_id = uuid7()
    user = User(
        id=user_id,
        email=f"placement-{user_id.hex}@example.test",
        username=f"placement_{user_id.hex[:12]}",
        status="active",
        role_id=role.id,
        role=role,
    )
    db.add(user)
    db.flush()
    return user


def _client(db: Session, user: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def test_placement_create_list_soft_delete_and_remove_are_scoped_and_audited(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, {"records.read": True, "records.write": True})
    viewer = _actor(db, {"records.read": True})
    outsider = _actor(db, {"records.read": True, "records.write": True})
    department = Department(department_name=f"Placement route {uuid7()}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id,
        module_name="Placement module",
        is_schema_accepted=True,
    )
    board = Board(owner_id=owner.id, name="Record shortcuts")
    db.add_all([module, board])
    db.flush()
    record = Record(module_id=module.id, data={})
    db.add(record)
    db.flush()
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=viewer.id,
            permission="view",
            effect="allow",
        )
    )
    db.commit()
    board_id, module_id, record_id = board.id, module.id, record.id
    set_audit_actor(db, owner.id)
    owner_client = _client(db, owner)
    viewer_client = _client(db, viewer)
    outsider_client = _client(db, outsider)

    assert outsider_client.get(f"/api/boards/{board_id}/placements").status_code == 404
    assert outsider_client.post(
        f"/api/boards/{board_id}/placements",
        json={"revision": 1, "record_id": str(record_id)},
    ).status_code == 404
    assert viewer_client.get(f"/api/boards/{board_id}/placements").status_code == 200
    assert viewer_client.post(
        f"/api/boards/{board_id}/placements",
        json={"revision": 1, "record_id": str(record_id)},
    ).status_code == 403

    created = owner_client.post(
        f"/api/boards/{board_id}/placements",
        json={"revision": 1, "record_id": str(record_id)},
    )
    assert created.status_code == 201
    placement_id = UUID(created.json()["placement"]["id"])
    assert created.headers["Location"] == f"/api/boards/{board_id}/placements/{placement_id}"
    assert created.json()["board_revision"] == 2
    assert created.json()["placement"]["module_id"] == str(module_id)
    assert created.json()["placement"]["available"] is True

    duplicate = owner_client.post(
        f"/api/boards/{board_id}/placements",
        json={"revision": 2, "record_id": str(record_id)},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"]["code"] == "placement_exists"
    listed = viewer_client.get(f"/api/boards/{board_id}/placements?limit=1&offset=0")
    assert listed.status_code == 200
    assert listed.headers["Cache-Control"] == "private, no-store"
    assert listed.json()["board_revision"] == 2
    assert listed.json()["pagination"]["total"] == 1
    assert listed.json()["items"][0]["id"] == str(placement_id)

    record.is_deleted = True
    record.deleted_at = utc_now()
    db.commit()
    unavailable = owner_client.get(f"/api/boards/{board_id}/placements")
    assert unavailable.status_code == 200
    assert unavailable.json()["items"][0]["available"] is False
    assert unavailable.json()["items"][0]["module_id"] is None
    assert db.get(BoardRecordPlacement, placement_id) is not None
    record.is_deleted = False
    record.deleted_at = None
    db.commit()
    assert owner_client.get(f"/api/boards/{board_id}/placements").json()["items"][0][
        "available"
    ] is True

    stale = owner_client.delete(f"/api/boards/{board_id}/placements/{placement_id}?revision=1")
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "stale_revision"
    removed = owner_client.delete(f"/api/boards/{board_id}/placements/{placement_id}?revision=2")
    assert removed.status_code == 204
    assert removed.headers["Cache-Control"] == "private, no-store"
    assert removed.content == b"" and "content-type" not in removed.headers
    assert db.get(BoardRecordPlacement, placement_id) is None
    assert db.get(Record, record_id) is not None
    assert db.get(Board, board_id).revision == 3
    assert owner_client.get(f"/api/boards/{board_id}/placements").json()["items"] == []
    audit_rows = db.scalars(
        select(AuditLog).where(
            AuditLog.entity_type == "board_record_placements",
            AuditLog.entity_id == placement_id,
        )
    ).all()
    assert {row.action for row in audit_rows} == {AuditAction.CREATE, AuditAction.DELETE}


def test_placement_mutations_reject_archived_board_and_unavailable_record(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, {"records.read": True, "records.write": True})
    department = Department(department_name=f"Placement unavailable {uuid7()}")
    db.add(department)
    db.flush()
    module = Module(department_id=department.id, module_name="Unaccepted module")
    board = Board(owner_id=owner.id, name="Operations")
    db.add_all([module, board])
    db.flush()
    record = Record(module_id=module.id, data={})
    db.add(record)
    db.commit()
    board_id, record_id = board.id, record.id
    set_audit_actor(db, owner.id)
    client = _client(db, owner)

    unavailable = client.post(
        f"/api/boards/{board_id}/placements",
        json={"revision": 1, "record_id": str(record_id)},
    )
    assert unavailable.status_code == 409
    assert unavailable.json()["detail"]["code"] == "record_unavailable"
    module.is_schema_accepted = True
    db.commit()
    board.status = BoardStatus.ARCHIVED
    db.commit()
    archived = client.post(
        f"/api/boards/{board_id}/placements",
        json={"revision": 1, "record_id": str(record_id)},
    )
    assert archived.status_code == 409
    assert archived.json()["detail"]["code"] == "board_archived"
    assert db.scalar(
        select(BoardRecordPlacement).where(BoardRecordPlacement.board_id == board_id)
    ) is None
