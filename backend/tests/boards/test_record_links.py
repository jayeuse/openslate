"""Internal Board Record links are contextual, revisioned, and purge-safe."""

from datetime import UTC, date, datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.systems.boards.announcement_models import BoardAnnouncement
from app.systems.boards.announcement_router import router as announcement_router
from app.systems.boards.announcement_service import publish_locked
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router as event_router
from app.systems.boards.models import Board
from app.systems.boards.record_link_models import (
    BoardAnnouncementRevisionRecordLink,
    BoardContentRecordLink,
)
from app.systems.boards.record_link_router import router
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.lifecycle.planning import plan_lifecycle
from app.systems.sandbox.lifecycle.schemas import LifecycleOperation, LifecycleTargetType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from tests.boards.test_announcement_routes import _actor, _board, _grant
from tests.boards.test_permanent_delete import _actor as _admin


def _client(db: Session, actor) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.include_router(event_router, prefix="/api")
    app.include_router(announcement_router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _source(db: Session) -> tuple[Module, Record]:
    department = Department(department_name=f"Record links {uuid7().hex}")
    db.add(department)
    db.flush()
    module = Module(
        department_id=department.id, module_name="Source records"
    )
    db.add(module)
    db.flush()
    record = Record(module_id=module.id, data={"private": "never serialize this"})
    db.add(record)
    db.flush()
    return module, record


def test_record_link_routes_are_mounted() -> None:
    paths = create_app().openapi()["paths"]
    assert "get" in paths["/api/boards/{board_id}/events/{event_id}/record-links"]
    assert "post" in paths["/api/boards/{board_id}/announcements/{announcement_id}/record-links"]


@pytest.mark.integration
def test_event_record_link_is_contextual_and_one_record_can_link_two_items(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "record-link-owner")
    excluded_admin = _admin(db, admin=True)
    board = _board(db, owner)
    other = _board(db, owner)
    module, record = _source(db)
    first = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Private event",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="UTC",
        audience_kind="author",
    )
    second = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Second event",
        all_day=True,
        start_date=date(2026, 9, 25),
        end_date=date(2026, 9, 25),
        timezone_name="UTC",
        audience_kind="author",
    )
    db.add_all((first, second))
    db.commit()
    path = f"/api/boards/{board.id}/events/{first.id}/record-links"
    with _client(db, owner) as client:
        linked = client.post(
            path,
            json={
                "record_id": str(record.id),
                "label": "Source request",
                "board_revision": 1,
                "content_revision": 1,
            },
        )
        assert linked.status_code == 201, linked.text
        assert linked.json()["module_id"] == str(module.id)
        assert linked.json()["url"] == f"/openview?module={module.id}&record={record.id}"
        listed = client.get(path)
        assert listed.status_code == 200
        assert listed.json()["items"][0]["label"] == "Source request"
        assert "private" not in listed.text
        wrong_board = client.get(f"/api/boards/{other.id}/events/{first.id}/record-links")
        assert wrong_board.status_code == 404
        assert (
            client.post(
                path,
                json={
                    "record_id": str(record.id),
                    "label": "Duplicate",
                    "board_revision": 1,
                    "content_revision": 1,
                },
            ).status_code
            == 409
        )
        second_link = client.post(
            f"/api/boards/{board.id}/events/{second.id}/record-links",
            json={
                "record_id": str(record.id),
                "label": "Also linked",
                "board_revision": 2,
                "content_revision": 1,
            },
        )
        assert second_link.status_code == 201, second_link.text
    with _client(db, excluded_admin) as client:
        denied = client.get(path)
        assert denied.status_code == 404
        assert denied.headers["cache-control"] == "no-store"
    assert (
        db.scalar(
            select(BoardContentRecordLink.id).where(
                BoardContentRecordLink.record_id == record.id,
                BoardContentRecordLink.event_id == first.id,
            )
        )
        is not None
    )


@pytest.mark.integration
def test_published_record_link_snapshot_survives_draft_unlink_and_blocks_source_purge(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "record-publication")
    reader = _actor(db, "record-reader", write=False)
    board = _board(db, owner)
    _grant(db, board, reader, "view")
    module, record = _source(db)
    item = BoardAnnouncement(
        board_id=board.id,
        author_id=owner.id,
        title="Record notice",
        body="See the record",
        audience_kind="everyone",
    )
    db.add(item)
    db.commit()
    path = f"/api/boards/{board.id}/announcements/{item.id}/record-links"
    with _client(db, owner) as client:
        linked = client.post(
            path,
            json={
                "record_id": str(record.id),
                "label": "Published source",
                "board_revision": 1,
                "content_revision": 1,
            },
        )
        assert linked.status_code == 201, linked.text
        link_id = linked.json()["id"]
    locked_board = db.scalar(select(Board).where(Board.id == board.id).with_for_update())
    locked_item = db.scalar(
        select(BoardAnnouncement).where(BoardAnnouncement.id == item.id).with_for_update()
    )
    assert locked_board is not None and locked_item is not None
    revision = publish_locked(
        db,
        locked_board,
        locked_item,
        owner,
        publication_key=uuid7(),
        published_at=datetime.now(UTC),
        board_revision=2,
        announcement_revision=2,
    )
    db.commit()
    assert (
        db.scalar(
            select(BoardAnnouncementRevisionRecordLink.record_id).where(
                BoardAnnouncementRevisionRecordLink.revision_id == revision.id
            )
        )
        == record.id
    )
    snapshot = db.scalar(
        select(BoardAnnouncementRevisionRecordLink).where(
            BoardAnnouncementRevisionRecordLink.revision_id == revision.id
        )
    )
    assert snapshot is not None
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            snapshot.label = "Rewritten history"
            db.flush()
    db.refresh(snapshot)
    with _client(db, owner) as client:
        removed = client.request(
            "DELETE",
            f"{path}/{link_id}",
            json={
                "board_revision": 3,
                "content_revision": 3,
            },
        )
        assert removed.status_code == 204, removed.text
        assert client.get(f"{path}?view=draft").json()["items"] == []
    with _client(db, reader) as client:
        published = client.get(path)
        assert published.status_code == 200, published.text
        assert published.json()["items"][0]["record_id"] == str(record.id)
        assert published.json()["items"][0]["module_id"] == str(module.id)
        assert "private" not in published.text
    record.is_deleted = True
    record.deleted_at = datetime.now(UTC)
    db.commit()
    plan = plan_lifecycle(
        db, LifecycleTargetType.RECORD, record.id, LifecycleOperation.PURGE, owner.id
    )
    assert any(
        blocker.entity_type == "board_announcement_revision_record_links"
        for blocker in plan.blockers
    )
    with _client(db, reader) as client:
        unavailable = client.get(path)
        assert unavailable.status_code == 200
        assert unavailable.json()["items"][0]["available"] is False
        assert unavailable.json()["items"][0]["url"] is None
    with _client(db, owner) as client:
        archived = client.post(
            f"/api/boards/{board.id}/announcements/{item.id}/archive",
            json={"board_revision": 4, "announcement_revision": 4},
        )
        assert archived.status_code == 200, archived.text
        deleted = client.request(
            "DELETE",
            f"/api/boards/{board.id}/announcements/{item.id}",
            json={"board_revision": 5, "announcement_revision": 5},
        )
        assert deleted.status_code == 204, deleted.text
    assert (
        db.scalar(
            select(BoardAnnouncementRevisionRecordLink.id).where(
                BoardAnnouncementRevisionRecordLink.record_id == record.id
            )
        )
        is None
    )
    after = plan_lifecycle(
        db, LifecycleTargetType.RECORD, record.id, LifecycleOperation.PURGE, owner.id
    )
    assert not any("board_" in blocker.entity_type for blocker in after.blockers)


@pytest.mark.integration
def test_archived_event_record_link_blocks_record_module_and_department_purge_until_delete(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "record-purge")
    board = _board(db, owner)
    module, record = _source(db)
    department = db.get(Department, module.department_id)
    assert department is not None
    event = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Retained event",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="UTC",
        audience_kind="everyone",
    )
    db.add(event)
    db.commit()
    path = f"/api/boards/{board.id}/events/{event.id}"
    with _client(db, owner) as client:
        linked = client.post(
            f"{path}/record-links",
            json={
                "record_id": str(record.id),
                "label": "Source",
                "board_revision": 1,
                "content_revision": 1,
            },
        )
        assert linked.status_code == 201, linked.text
        archived = client.post(
            f"{path}/archive",
            json={
                "board_revision": 2,
                "event_revision": 2,
            },
        )
        assert archived.status_code == 200, archived.text
    for row in (record, module, department):
        row.is_deleted = True
        row.deleted_at = datetime.now(UTC)
    db.commit()
    for target, target_id in (
        (LifecycleTargetType.RECORD, record.id),
        (LifecycleTargetType.MODULE, module.id),
        (LifecycleTargetType.DEPARTMENT, department.id),
    ):
        plan = plan_lifecycle(db, target, target_id, LifecycleOperation.PURGE, owner.id)
        assert any(blocker.entity_type == "board_content_record_links" for blocker in plan.blockers)
    with _client(db, owner) as client:
        deleted = client.request(
            "DELETE",
            path,
            json={
                "board_revision": 3,
                "event_revision": 3,
            },
        )
        assert deleted.status_code == 204, deleted.text
    assert (
        db.scalar(
            select(BoardContentRecordLink.id).where(BoardContentRecordLink.record_id == record.id)
        )
        is None
    )


@pytest.mark.integration
def test_record_link_cap_and_database_parent_guards(integration_owner_db: Session) -> None:
    db = integration_owner_db
    owner = _actor(db, "record-guard")
    write_only = _actor(db, "record-write-only", read=False)
    board = _board(db, owner)
    wrong_board = _board(db, owner)
    _grant(db, board, write_only, "edit")
    module, record = _source(db)
    event = BoardEvent(
        board_id=board.id,
        author_id=owner.id,
        title="Bounded event",
        all_day=True,
        start_date=date(2026, 9, 24),
        end_date=date(2026, 9, 24),
        timezone_name="UTC",
        audience_kind="everyone",
    )
    db.add(event)
    db.flush()
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            db.add(
                BoardContentRecordLink(
                    board_id=wrong_board.id,
                    event_id=event.id,
                    record_id=record.id,
                    module_id=module.id,
                    label="Wrong Board",
                )
            )
            db.flush()
    for index in range(20):
        source = Record(module_id=module.id, data={"index": index})
        db.add(source)
        db.flush()
        db.add(
            BoardContentRecordLink(
                board_id=board.id,
                event_id=event.id,
                record_id=source.id,
                module_id=module.id,
                label=f"Source {index}",
            )
        )
    db.commit()
    path = f"/api/boards/{board.id}/events/{event.id}/record-links"
    payload = {
        "record_id": str(record.id),
        "label": "Overflow",
        "board_revision": 1,
        "content_revision": 1,
    }
    with _client(db, write_only) as client:
        assert client.post(path, json=payload).status_code == 403
    with _client(db, owner) as client:
        full = client.post(path, json=payload)
        assert full.status_code == 409
        assert full.json()["detail"]["code"] == "record_link_limit"
