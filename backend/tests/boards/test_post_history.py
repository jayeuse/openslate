"""Post edit history, delete-or-archive, and the author filter on scoped Boards."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import UserRole
from app.systems.boards.post_author_router import router as author_router
from app.systems.boards.post_manage_state_router import router as manage_state_router
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.post_revision_router import router as revision_router
from app.systems.boards.post_router import router as post_router
from app.systems.platform.scheduling.models import InAppNotification, ScheduledWork, WorkKind
from tests.boards.support import client, grant, member, project_board
from tests.conftest import membership_of
from tests.rbac.support import add_user

pytestmark = pytest.mark.integration

ROUTERS = (author_router, manage_state_router, revision_router, post_router)


def _create(api, board_id, board_revision: int, title: str = "Stock count") -> dict[str, object]:
    response = api.post(
        f"/api/boards/{board_id}/posts",
        json={"board_revision": board_revision, "title": title, "body": "Friday at 9."},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _publish(api, board_id, post: dict[str, object]) -> dict[str, object]:
    response = api.post(
        f"/api/boards/{board_id}/posts/{post['id']}/publish",
        json={
            "board_revision": post["board_revision"],
            "post_revision": post["post_revision"],
            "publication_key": str(uuid7()),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _state(api, board_id, post_id) -> dict[str, object]:
    response = api.get(f"/api/boards/{board_id}/posts/{post_id}/manage-state")
    assert response.status_code == 200, response.text
    return response.json()


def test_each_publish_adds_a_revision_that_every_reader_can_open(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author, reader, outsider = member(db), member(db), member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    writer = client(db, author, *ROUTERS)

    created = _create(writer, board.id, board.revision)
    _publish(writer, board.id, {**created, **_state(writer, board.id, created["id"])})
    state = _state(writer, board.id, created["id"])
    edited = writer.patch(
        f"/api/boards/{board.id}/posts/{created['id']}",
        json={
            "board_revision": state["board_revision"],
            "post_revision": state["post_revision"],
            "body": "Moved to Saturday at 9.",
        },
    )
    assert edited.status_code == 200
    _publish(writer, board.id, {"id": created["id"], **_state(writer, board.id, created["id"])})

    viewer = client(db, reader, *ROUTERS)
    shown = viewer.get(f"/api/boards/{board.id}/posts/{created['id']}").json()
    assert shown["body"] == "Moved to Saturday at 9."
    assert shown["edited"] is True
    history = viewer.get(f"/api/boards/{board.id}/posts/{created['id']}/revisions")
    assert history.status_code == 200
    numbers = [item["publication_number"] for item in history.json()["items"]]
    assert numbers == [2, 1]
    bodies = [
        viewer.get(f"/api/boards/{board.id}/posts/{created['id']}/revisions/{item['id']}").json()[
            "body"
        ]
        for item in history.json()["items"]
    ]
    assert bodies == ["Moved to Saturday at 9.", "Friday at 9."]
    assert (
        client(db, outsider, *ROUTERS)
        .get(f"/api/boards/{board.id}/posts/{created['id']}/revisions")
        .status_code
        == 404
    )


def test_publication_notifies_every_reader_of_the_board(integration_owner_db: Session) -> None:
    db = integration_owner_db
    author, reader, outsider = member(db), member(db), member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    writer = client(db, author, *ROUTERS)
    created = _create(writer, board.id, board.revision)
    _publish(writer, board.id, {**created, **_state(writer, board.id, created["id"])})

    work = db.scalar(
        select(ScheduledWork).where(
            ScheduledWork.kind == WorkKind.POST_PUBLISH, ScheduledWork.post_id == created["id"]
        )
    )
    assert work is not None
    recipients = set(
        db.scalars(
            select(InAppNotification.recipient_id).where(InAppNotification.work_id == work.id)
        )
    )
    assert {author.id, reader.id} <= recipients
    assert outsider.id not in recipients


def test_deleting_a_draft_removes_it_and_deleting_a_published_post_archives_it(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author, manager = member(db), member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    grant(db, board, [manager], AccessLevel.MANAGE)
    writer = client(db, author, *ROUTERS)

    draft = _create(writer, board.id, board.revision, "Draft only")
    state = _state(writer, board.id, draft["id"])
    assert state["published_before"] is False
    removed = writer.request(
        "DELETE",
        f"/api/boards/{board.id}/posts/{draft['id']}",
        json={"board_revision": state["board_revision"], "post_revision": state["post_revision"]},
    )
    assert removed.status_code == 200
    assert removed.json()["outcome"] == "deleted"
    assert db.get(BoardPost, draft["id"]) is None

    published = _create(writer, board.id, removed.json()["board_revision"], "Published")
    _publish(writer, board.id, {**published, **_state(writer, board.id, published["id"])})
    state = _state(writer, board.id, published["id"])
    assert state["published_before"] is True
    archived = writer.request(
        "DELETE",
        f"/api/boards/{board.id}/posts/{published['id']}",
        json={"board_revision": state["board_revision"], "post_revision": state["post_revision"]},
    )
    assert archived.status_code == 200
    assert archived.json()["outcome"] == "archived"
    kept = db.scalars(
        select(BoardPostRevision).where(BoardPostRevision.post_id == published["id"])
    ).all()
    assert len(kept) == 1
    assert writer.get(f"/api/boards/{board.id}/posts/{published['id']}").status_code == 404
    history = client(db, manager, *ROUTERS).get(
        f"/api/boards/{board.id}/posts/{published['id']}/revisions"
    )
    assert history.status_code == 200 and len(history.json()["items"]) == 1
    state = _state(writer, board.id, published["id"])
    again = writer.request(
        "DELETE",
        f"/api/boards/{board.id}/posts/{published['id']}",
        json={"board_revision": state["board_revision"], "post_revision": state["post_revision"]},
    )
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "post_archived"


def test_the_author_filter_lists_only_active_unexpired_authors(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board = project_board(db)
    active, disabled = member(db, "active-author"), member(db, "disabled-author")
    expiring = add_user(
        db, "expiring-author", role=UserRole.GUEST, expires_at=datetime.now(UTC) + timedelta(days=1)
    )
    reader = member(db)
    grant(db, board, [active, disabled, reader], AccessLevel.WRITE)
    now = datetime.now(UTC)
    for author in (active, disabled, expiring):
        item = BoardPost(
            org_id=board.org_id,
            board_id=board.id,
            author_id=author.id,
            title="Posted",
            body="Body",
            status="published",
            publish_at=now,
            displayed_publication_number=1,
        )
        db.add(item)
        db.flush()
        db.add(
            BoardPostRevision(
                org_id=item.org_id,
                post_id=item.id,
                publication_number=1,
                publication_key=uuid7(),
                content_fingerprint="b" * 64,
                author_id=author.id,
                title="Posted",
                body="Body",
                published_at=now,
            )
        )
    disabled.status = "disabled"
    membership_of(db, expiring.id).expires_at = now - timedelta(minutes=1)
    db.flush()

    response = client(db, reader, *ROUTERS).get(f"/api/boards/{board.id}/post-authors")
    assert [item["id"] for item in response.json()["items"]] == [str(active.id)]
