"""Retained announcement personal state must be inventoried before physical deletion."""

from datetime import UTC, datetime
from secrets import token_urlsafe

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_personal_models import BoardAnnouncementPersonalState
from app.systems.boards.models import Board
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditLog
from tests.boards.test_announcement_routes import _actor as announcement_actor
from tests.boards.test_announcement_routes import _board as announcement_board
from tests.boards.test_announcement_routes import _client as announcement_client
from tests.boards.test_permanent_delete import _actor as purge_actor
from tests.boards.test_permanent_delete import _client as purge_client
from tests.boards.test_permanent_delete import _enabled

pytestmark = pytest.mark.integration


def test_archived_announcement_delete_removes_audited_personal_rows_before_parent(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    manager = announcement_actor(db, "personal-delete-manager")
    reader = announcement_actor(db, "personal-delete-reader")
    set_audit_actor(db, manager.id)
    board = announcement_board(db, manager)
    item = BoardAnnouncement(
        board_id=board.id,
        author_id=manager.id,
        title="Private archived title",
        body="Private archived body",
        status="archived",
        audience_kind="everyone",
    )
    db.add(item)
    db.flush()
    revision = BoardAnnouncementRevision(
        announcement_id=item.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=manager.id,
        title="Private publication title",
        body="Private publication body",
        audience_kind="everyone",
        published_at=datetime.now(UTC),
    )
    state = BoardAnnouncementPersonalState(
        user_id=reader.id, announcement_id=item.id, read=True, bookmarked=True
    )
    db.add_all([revision, state])
    db.commit()

    response = announcement_client(db, manager).request(
        "DELETE",
        f"/api/boards/{board.id}/announcements/{item.id}",
        json={"board_revision": board.revision, "announcement_revision": item.revision},
    )

    assert response.status_code == 204, response.text
    assert db.get(BoardAnnouncementPersonalState, state.id) is None
    assert db.get(BoardAnnouncementRevision, revision.id) is None
    assert db.get(BoardAnnouncement, item.id) is None
    assert db.get(Board, board.id).revision == 2
    assert (
        db.scalar(
            select(AuditLog).where(
                AuditLog.action == "delete",
                AuditLog.entity_type == "board_announcement_personal_states",
                AuditLog.entity_id == state.id,
            )
        )
        is not None
    )


def test_board_purge_challenges_all_personal_rows_detects_flag_drift_and_deletes_them(
    integration_owner_db: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = integration_owner_db
    password = token_urlsafe(32)
    admin = purge_actor(db, admin=True, password=password)
    reader = purge_actor(db, admin=False)
    set_audit_actor(db, admin.id)
    board = Board(owner_id=admin.id, name="Private Board title", status="archived")
    db.add(board)
    db.flush()
    archived = BoardAnnouncement(
        board_id=board.id,
        author_id=admin.id,
        title="Private archived title",
        body="Private archived body",
        status="archived",
        audience_kind="everyone",
    )
    deleted = BoardAnnouncement(
        board_id=board.id,
        author_id=admin.id,
        title="Private deleted title",
        body="Private deleted body",
        status="published",
        audience_kind="everyone",
        is_deleted=True,
        deleted_at=datetime.now(UTC),
    )
    db.add_all([archived, deleted])
    db.flush()
    archived_state = BoardAnnouncementPersonalState(
        user_id=admin.id, announcement_id=archived.id, read=True
    )
    deleted_state = BoardAnnouncementPersonalState(
        user_id=reader.id, announcement_id=deleted.id, bookmarked=True
    )
    db.add_all([archived_state, deleted_state])
    db.commit()
    _enabled(monkeypatch, True)
    client = purge_client(db, admin)
    path = f"/api/boards/{board.id}/purge"

    preview = client.post(f"{path}/preview")
    assert preview.status_code == 200, preview.text
    rows = [
        row
        for row in preview.json()["impact"]["rows"]
        if row["entity_type"] == "board_announcement_personal_states"
    ]
    assert {row["entity_id"] for row in rows} == {str(archived_state.id), str(deleted_state.id)}
    assert all(len(row["state_fingerprint"]) == 64 for row in rows)
    assert "Private" not in preview.text
    assert "bookmarked" not in preview.text

    archived_state.bookmarked = True
    db.commit()
    stale = client.post(
        path,
        json={
            "token": preview.json()["token"],
            "confirmation_name": str(board.id),
            "password": password,
        },
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "impact_changed"
    assert db.get(Board, board.id) is not None
    assert db.get(BoardAnnouncementPersonalState, archived_state.id) is not None

    current = client.post(f"{path}/preview")
    assert current.status_code == 200
    assert current.json()["impact"]["impact_digest"] != preview.json()["impact"]["impact_digest"]
    purged = client.post(
        path,
        json={
            "token": current.json()["token"],
            "confirmation_name": str(board.id),
            "password": password,
        },
    )
    assert purged.status_code == 200, purged.text
    for row in (archived_state, deleted_state):
        assert db.get(BoardAnnouncementPersonalState, row.id) is None
    assert db.get(BoardAnnouncement, archived.id) is None
    assert db.get(BoardAnnouncement, deleted.id) is None
    assert db.get(Board, board.id) is None
    audited = db.scalars(
        select(AuditLog).where(
            AuditLog.action == "delete",
            AuditLog.entity_type == "board_announcement_personal_states",
            AuditLog.entity_id.in_([archived_state.id, deleted_state.id]),
        )
    ).all()
    assert {row.entity_id for row in audited} == {archived_state.id, deleted_state.id}
