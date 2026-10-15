"""Board post HTTP views, publication, lifecycle and revision contracts."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.post_router import router
from app.systems.boards.post_schemas import PostCreate, PostSchedule
from tests.boards.support import client, grant, member, project_board

_LEVELS = {"view": AccessLevel.READ, "edit": AccessLevel.WRITE, "manage": AccessLevel.MANAGE}


def _client(db: Session, actor: User) -> TestClient:
    return client(db, actor, router)


def _actor(db: Session, label: str, *, write: bool = True) -> User:
    return member(db, label)


def _board(db: Session, owner: User) -> Board:
    """A project Board on which ``owner`` writes."""

    board = project_board(db, f"Post Board {uuid7().hex[:8]}")
    grant(db, board, [owner], AccessLevel.WRITE)
    return board


def _grant(db: Session, board: Board, actor: User, permission: str) -> None:
    grant(db, board, [actor], _LEVELS.get(permission, permission))


def _create_payload(board_revision: int, **changes: object) -> dict[str, object]:
    return {
        "board_revision": board_revision,
        "title": "Opening notice",
        "body": "The office is open.",
        **changes,
    }


def test_post_input_rejects_audiences_unknown_fields_and_non_utc_timing() -> None:
    valid = _create_payload(1)
    assert PostCreate.model_validate(valid).title == "Opening notice"
    for candidate in (
        {**valid, "audience": {"kind": "everyone"}},
        {**valid, "title": "  "},
        {**valid, "body": "x" * 2001},
        {**valid, "expires_at": "2026-09-24T10:00:00+08:00"},
        {**valid, "attachments": []},
    ):
        with pytest.raises(ValidationError):
            PostCreate.model_validate(candidate)
    with pytest.raises(ValidationError):
        PostSchedule.model_validate(
            {"board_revision": 1, "post_revision": 1, "publish_at": "2026-09-25T10:00:00"}
        )


@pytest.mark.integration
def test_views_show_readers_the_published_version_and_writers_their_own_drafts(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = _actor(db, "views-author")
    other_writer = _actor(db, "views-other")
    manager = _actor(db, "views-manager")
    reader = _actor(db, "views-reader")
    board = _board(db, author)
    _grant(db, board, other_writer, "edit")
    _grant(db, board, manager, "manage")
    _grant(db, board, reader, "view")
    db.commit()
    root = f"/api/boards/{board.id}/posts"
    author_client = _client(db, author)
    created = author_client.post(root, json=_create_payload(1))
    item_id = created.json()["id"]
    author_client.post(
        f"{root}/{item_id}/publish",
        json={"board_revision": 2, "post_revision": 1, "publication_key": str(uuid7())},
    )
    author_client.patch(
        f"{root}/{item_id}",
        json={"board_revision": 3, "post_revision": 2, "title": "Unpublished edit"},
    )
    draft = author_client.post(root, json=_create_payload(4, title="Only a draft"))
    assert draft.status_code == 201

    shown = _client(db, reader).get(f"{root}?view=published").json()
    assert [item["title"] for item in shown["items"]] == ["Opening notice"]
    assert shown["items"][0]["post_revision"] is None
    assert _client(db, reader).get(f"{root}?view=draft").json()["pagination"]["total"] == 0
    assert _client(db, reader).get(f"{root}?view=editable").status_code == 403
    assert _client(db, reader).get(f"{root}?view=archive").status_code == 403
    assert _client(db, other_writer).get(f"{root}?view=editable").json()["pagination"]["total"] == 0
    assert _client(db, author).get(f"{root}?view=editable").json()["pagination"]["total"] == 2
    assert _client(db, manager).get(f"{root}?view=draft").json()["pagination"]["total"] == 2
    detail = _client(db, author).get(f"{root}/{item_id}?view=editable")
    assert detail.status_code == 200 and detail.json()["title"] == "Unpublished edit"
    assert _client(db, other_writer).get(f"{root}/{item_id}?view=editable").status_code == 404
    assert _client(db, reader).get(f"{root}/{item_id}").json()["title"] == "Opening notice"


@pytest.mark.integration
def test_post_publication_retry_archive_restore_and_delete(integration_owner_db: Session) -> None:
    db = integration_owner_db
    owner = _actor(db, "lifecycle-owner")
    manager = _actor(db, "lifecycle-manager")
    board = _board(db, owner)
    _grant(db, board, manager, "manage")
    db.commit()
    root = f"/api/boards/{board.id}/posts"
    owner_client, manager_client = _client(db, owner), _client(db, manager)

    created = owner_client.post(root, json=_create_payload(1))
    assert created.status_code == 201
    post_id = created.json()["id"]
    assert created.json() == {"id": post_id, "post_revision": 1, "board_revision": 2}
    assert created.headers["Location"] == f"{root}/{post_id}?view=draft"
    key = uuid7()
    publish_body = {"board_revision": 2, "post_revision": 1, "publication_key": str(key)}
    first = owner_client.post(f"{root}/{post_id}/publish", json=publish_body)
    assert first.status_code == 200
    assert owner_client.post(f"{root}/{post_id}/publish", json=publish_body).json() == first.json()
    replay = manager_client.post(f"{root}/{post_id}/publish", json=publish_body)
    assert replay.status_code == 409
    assert replay.json()["detail"]["code"] == "publication_key_conflict"

    changed = owner_client.patch(
        f"{root}/{post_id}",
        json={"board_revision": 3, "post_revision": 2, "title": "Replacement"},
    )
    assert changed.status_code == 200
    scheduled = manager_client.post(
        f"{root}/{post_id}/schedule",
        json={
            "board_revision": 4,
            "post_revision": 3,
            "publish_at": (datetime.now(UTC) + timedelta(days=2)).isoformat(),
        },
    )
    assert scheduled.status_code == 200
    assert manager_client.get(f"{root}/{post_id}").json()["title"] == "Opening notice"
    unpublished = owner_client.post(
        f"{root}/{post_id}/unpublish", json={"board_revision": 5, "post_revision": 4}
    )
    assert unpublished.status_code == 200
    assert manager_client.get(f"{root}/{post_id}").status_code == 404
    archived = owner_client.post(
        f"{root}/{post_id}/archive", json={"board_revision": 6, "post_revision": 5}
    )
    assert archived.status_code == 200
    assert manager_client.get(f"{root}?view=archive").json()["pagination"]["total"] == 1
    restored = owner_client.post(
        f"{root}/{post_id}/restore", json={"board_revision": 7, "post_revision": 6}
    )
    assert restored.status_code == 200
    kept = manager_client.request(
        "DELETE", f"{root}/{post_id}", json={"board_revision": 8, "post_revision": 7}
    )
    assert kept.status_code == 200
    assert kept.json()["outcome"] == "archived"
    assert kept.headers["Cache-Control"] == "private, no-store"
    assert db.get(BoardPost, post_id) is not None
    assert db.scalar(select(BoardPostRevision.id).where(BoardPostRevision.post_id == post_id))


@pytest.mark.integration
def test_post_rejects_stale_and_unmanaged_writes_without_partial_changes(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner, editor, other_editor, manager = (
        _actor(db, label) for label in ("owner", "editor", "other", "manager")
    )
    board = _board(db, owner)
    for actor, permission in ((editor, "edit"), (other_editor, "edit"), (manager, "manage")):
        _grant(db, board, actor, permission)
    db.commit()
    root = f"/api/boards/{board.id}/posts"
    api = _client(db, editor)
    created = api.post(root, json=_create_payload(1))
    assert created.status_code == 201
    item_id = created.json()["id"]

    not_mine = _client(db, other_editor).patch(
        f"{root}/{item_id}", json={"board_revision": 2, "post_revision": 1, "title": "Not mine"}
    )
    assert not_mine.status_code == 403
    assert (
        _client(db, other_editor)
        .post(f"{root}/{item_id}/archive", json={"board_revision": 2, "post_revision": 1})
        .status_code
        == 403
    )
    stale_board = api.patch(
        f"{root}/{item_id}", json={"board_revision": 1, "post_revision": 1, "title": "Stale"}
    )
    assert stale_board.json()["detail"]["code"] == "stale_board_revision"
    stale_post = api.patch(
        f"{root}/{item_id}", json={"board_revision": 2, "post_revision": 2, "title": "Stale"}
    )
    assert stale_post.json()["detail"]["code"] == "stale_post_revision"
    past = api.post(
        f"{root}/{item_id}/schedule",
        json={
            "board_revision": 2,
            "post_revision": 1,
            "publish_at": (datetime.now(UTC) - timedelta(days=1)).isoformat(),
        },
    )
    assert past.status_code == 422
    assert past.json()["detail"]["code"] == "post_schedule_invalid"
    stored = db.get(BoardPost, item_id)
    assert stored is not None and stored.title == "Opening notice" and stored.revision == 1
    assert db.get(Board, board.id).revision == 2
    managed = _client(db, manager).patch(
        f"{root}/{item_id}",
        json={"board_revision": 2, "post_revision": 1, "title": "Manager edit"},
    )
    assert managed.status_code == 200


@pytest.mark.integration
def test_published_list_orders_by_displayed_revision_not_unpublished_draft_timestamps(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "order-owner")
    reader = _actor(db, "order-reader")
    board = _board(db, owner)
    _grant(db, board, reader, "view")
    now = datetime.now(UTC)
    early_parent = BoardPost(
        org_id=board.org_id,
        board_id=board.id,
        author_id=owner.id,
        title="B visible",
        body="B body",
        status="published",
        displayed_publication_number=1,
        created_at=now - timedelta(days=6),
        updated_at=now - timedelta(days=2),
    )
    later_parent_with_draft = BoardPost(
        org_id=board.org_id,
        board_id=board.id,
        author_id=owner.id,
        title="Private unpublished edit",
        body="New private body",
        status="draft",
        displayed_publication_number=1,
        created_at=now - timedelta(days=4),
        updated_at=now - timedelta(days=1),
    )
    db.add_all([early_parent, later_parent_with_draft])
    db.flush()
    for parent, title, published_at in (
        (early_parent, "B visible", now - timedelta(days=2)),
        (later_parent_with_draft, "A visible", now - timedelta(days=3)),
    ):
        db.add(
            BoardPostRevision(
                org_id=parent.org_id,
                post_id=parent.id,
                publication_number=1,
                publication_key=uuid7(),
                content_fingerprint="a" * 64,
                author_id=owner.id,
                title=title,
                body="Public body",
                published_at=published_at,
                created_at=published_at,
                updated_at=published_at,
            )
        )
    db.commit()
    api = _client(db, reader)
    for suffix, expected in (
        ("", early_parent.id),
        ("&sort_by=updated_at&sort_order=desc", early_parent.id),
        ("&sort_by=created_at&sort_order=asc", later_parent_with_draft.id),
    ):
        result = api.get(f"/api/boards/{board.id}/posts?view=published&limit=1{suffix}")
        assert result.status_code == 200 and result.json()["pagination"]["total"] == 2
        assert result.json()["items"][0]["id"] == str(expected)


@pytest.mark.integration
@pytest.mark.parametrize("view", ("published", "editable", "draft", "archive"))
def test_default_post_order_is_pinned_first_before_paging(
    integration_owner_db: Session, view: str
) -> None:
    db = integration_owner_db
    owner = _actor(db, "pinned-order-owner")
    board = _board(db, owner)
    _grant(db, board, owner, "manage")
    now = datetime.now(UTC)
    items = []
    for index, (title, pinned, age) in enumerate(
        (("Z pinned", True, 3), ("B recent", False, 1), ("A recent", False, 1))
    ):
        timestamp = now - timedelta(days=age)
        item = BoardPost(
            org_id=board.org_id,
            board_id=board.id,
            author_id=owner.id,
            title=title,
            body="Private draft body",
            pinned=pinned,
            status="archived" if view == "archive" else "draft",
            displayed_publication_number=1,
            created_at=timestamp,
            # The private replacement must not choose the published order.
            updated_at=timestamp if view != "published" else now + timedelta(days=index),
        )
        db.add(item)
        db.flush()
        db.add(
            BoardPostRevision(
                org_id=item.org_id,
                post_id=item.id,
                publication_number=1,
                publication_key=uuid7(),
                content_fingerprint="a" * 64,
                author_id=owner.id,
                title=title,
                body="Displayed publication body",
                published_at=timestamp,
                created_at=timestamp,
                updated_at=timestamp,
            )
        )
        items.append(item)
    db.commit()
    api = _client(db, owner)
    root = f"/api/boards/{board.id}/posts"
    for suffix in ("", "&sort_by=updated_at&sort_order=desc"):
        returned = []
        for offset in range(3):
            result = api.get(f"{root}?view={view}&limit=1&offset={offset}{suffix}")
            assert result.status_code == 200, result.text
            page = result.json()
            assert page["pagination"] == {
                "limit": 1,
                "offset": offset,
                "count": 1,
                "total": 3,
                "has_more": offset < 2,
            }
            returned.append(page["items"][0]["id"])
        assert returned == [str(items[0].id), str(items[2].id), str(items[1].id)]
    for suffix, expected in (
        ("&sort_by=title&sort_order=asc", items[2].id),
        ("&sort_by=created_at&sort_order=desc", items[2].id),
        ("&sort_by=updated_at&sort_order=asc", items[0].id),
    ):
        result = api.get(f"{root}?view={view}&limit=1{suffix}")
        assert result.status_code == 200, result.text
        assert result.json()["items"][0]["id"] == str(expected)
