"""Current-user announcement read/bookmark authorization and state contracts."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.users.models import User
from app.systems.boards.announcement_models import (
    BoardAnnouncement,
    BoardAnnouncementRevision,
    publication_content_fingerprint,
)
from app.systems.boards.announcement_personal_models import BoardAnnouncementPersonalState
from app.systems.boards.announcement_personal_router import router
from app.systems.boards.models import Board, BoardGrant
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditLog
from tests.rbac.support import capability_actor, make_user


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _actor(db: Session, label: str, *, read: bool = True) -> User:
    """A member; Boards reads need no capability since slice 3."""

    return capability_actor(db, "board", {"records.write": True})


def _grant(db: Session, board: Board, actor: User, permission: str = "view") -> BoardGrant:
    grant = BoardGrant(
        board_id=board.id,
        principal_type="user",
        principal_user_id=actor.id,
        permission=permission,
        effect="allow",
    )
    db.add(grant)
    return grant


def _published(
    db: Session,
    board: Board,
    author: User,
    *,
    audience_kind: str = "everyone",
    audience_user_id=None,
    expires_at: datetime | None = None,
) -> tuple[BoardAnnouncement, BoardAnnouncementRevision]:
    item = BoardAnnouncement(
        board_id=board.id,
        author_id=author.id,
        title="Current working title",
        body="Current working body",
        status="published",
        audience_kind="everyone",
        displayed_publication_number=1,
    )
    db.add(item)
    db.flush()
    revision = BoardAnnouncementRevision(
        announcement_id=item.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint=publication_content_fingerprint(
            author_id=author.id,
            title="Displayed title",
            body="Displayed body",
            audience_kind=audience_kind,
            audience_user_id=audience_user_id,
            expires_at=expires_at,
        ),
        author_id=author.id,
        title="Displayed title",
        body="Displayed body",
        audience_kind=audience_kind,
        audience_user_id=audience_user_id,
        published_at=datetime.now(UTC) - timedelta(days=3),
        expires_at=expires_at,
    )
    db.add(revision)
    db.flush()
    return item, revision


def _url(board: Board, item: BoardAnnouncement) -> str:
    return f"/api/boards/{board.id}/announcements/{item.id}/personal"


def _put_read(client: TestClient, url: str, number: int, value: bool):
    return client.put(f"{url}/read", json={"publication_number": number, "read": value})


def _put_bookmark(client: TestClient, url: str, number: int, value: bool):
    return client.put(f"{url}/bookmark", json={"publication_number": number, "bookmarked": value})


def test_personal_announcement_routes_require_a_strict_payload() -> None:
    board_id, announcement_id = uuid7(), uuid7()
    root = f"/api/boards/{board_id}/announcements/{announcement_id}/personal"
    db = Mock(spec=Session)
    reader = make_user("announcement_personal_reader", role="guest")
    for path, payload in (
        ("read", {"publication_number": 1, "read": "true"}),
        ("read", {"publication_number": 1}),
        ("read", {"publication_number": 0, "read": True}),
        ("bookmark", {"publication_number": 1, "bookmarked": "true"}),
        ("bookmark", {"publication_number": 1, "bookmarked": True, "read": False}),
        ("read", {"publication_number": 1, "read": True, "user_id": str(uuid7())}),
    ):
        assert _client(db, reader).put(f"{root}/{path}", json=payload).status_code == 422
    assert _client(db, reader).put(root, json={"read": True}).status_code == 405


@pytest.mark.integration
def test_personal_flags_are_current_user_only_idempotent_and_audited(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner, viewer, other = (_actor(db, label) for label in ("owner", "viewer", "other"))
    board = Board(owner_id=owner.id, name="Personal announcement")
    db.add(board)
    db.flush()
    _grant(db, board, viewer)
    _grant(db, board, other)
    item, _ = _published(db, board, owner)
    db.commit()
    viewer_client, other_client = _client(db, viewer), _client(db, other)
    url = _url(board, item)
    set_audit_actor(db, viewer.id)

    initial = viewer_client.get(url)
    assert initial.status_code == 200
    assert initial.headers["Cache-Control"] == "private, no-store"
    assert initial.json() == {
        "announcement_id": str(item.id),
        "publication_number": 1,
        "read": False,
        "bookmarked": False,
    }
    assert _put_read(viewer_client, url, 1, False).json() == initial.json()
    assert db.scalar(select(func.count()).select_from(BoardAnnouncementPersonalState)) == 0

    saved = _put_bookmark(viewer_client, url, 1, True)
    assert saved.status_code == 200
    assert saved.json() == initial.json() | {"bookmarked": True}
    stale_read = _put_read(viewer_client, url, 1, True)
    assert stale_read.json() == initial.json() | {"read": True, "bookmarked": True}
    state = db.scalar(select(BoardAnnouncementPersonalState))
    assert state is not None and state.user_id == viewer.id
    assert other_client.get(url).json() == initial.json()
    assert _put_read(viewer_client, url, 1, True).status_code == 200
    assert (
        db.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(
                AuditLog.entity_type == "board_announcement_personal_states",
                AuditLog.entity_id == state.id,
            )
        )
        == 2
    )
    cleared = _put_read(viewer_client, url, 1, False)
    assert cleared.json() == initial.json() | {"bookmarked": True}
    assert _put_bookmark(viewer_client, url, 1, False).json() == initial.json()
    assert _put_bookmark(viewer_client, url, 1, False).status_code == 200
    assert (
        db.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(
                AuditLog.entity_type == "board_announcement_personal_states",
                AuditLog.entity_id == state.id,
            )
        )
        == 4
    )
    assert board.revision == 1

    state.read = True
    state.is_deleted = True
    state.deleted_at = datetime.now(UTC)
    db.commit()
    assert viewer_client.get(url).json() == initial.json()
    assert _put_read(viewer_client, url, 1, False).status_code == 200
    assert db.scalar(select(func.count()).select_from(BoardAnnouncementPersonalState)) == 1
    db.refresh(state)
    assert state.is_deleted is True
    state.is_deleted = False
    db.commit()
    assert _put_read(viewer_client, url, 1, False).json() == initial.json()
    restored = _put_bookmark(viewer_client, url, 1, True)
    assert restored.status_code == 200
    assert restored.json() == initial.json() | {"bookmarked": True}
    assert db.scalar(select(func.count()).select_from(BoardAnnouncementPersonalState)) == 1
    db.refresh(state)
    assert state.is_deleted is False and state.deleted_at is None


@pytest.mark.integration
def test_personal_state_hides_excluded_audiences_even_from_board_managers_and_owners(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner, viewer, manager = (_actor(db, label) for label in ("private-owner", "target", "manager"))
    board = Board(owner_id=owner.id, name="Restricted announcement")
    db.add(board)
    db.flush()
    _grant(db, board, viewer)
    _grant(db, board, manager, "manage")
    item, _ = _published(db, board, owner, audience_kind="user", audience_user_id=viewer.id)
    db.commit()
    url = _url(board, item)
    assert _client(db, viewer).get(url).status_code == 200
    for excluded in (owner, manager):
        client = _client(db, excluded)
        assert client.get(url).status_code == 404
        assert _put_bookmark(client, url, 1, True).status_code == 404
    assert db.scalar(select(func.count()).select_from(BoardAnnouncementPersonalState)) == 0
    item.status = "archived"
    db.commit()
    assert _client(db, viewer).get(url).status_code == 404
    assert _put_read(_client(db, viewer), url, 1, True).status_code == 404


@pytest.mark.integration
def test_personal_state_matches_published_expiry_for_manager_but_not_other_viewers(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner, manager, viewer = (
        _actor(db, label) for label in ("expiry-owner", "expiry-manager", "expiry-viewer")
    )
    board = Board(owner_id=owner.id, name="Expired announcement")
    db.add(board)
    db.flush()
    _grant(db, board, manager, "manage")
    _grant(db, board, viewer)
    item, _ = _published(db, board, owner, expires_at=datetime.now(UTC) - timedelta(days=1))
    db.commit()
    url = _url(board, item)
    assert _client(db, viewer).get(url).status_code == 404
    assert _put_read(_client(db, viewer), url, 1, True).status_code == 404
    assert _client(db, manager).get(url).status_code == 200


@pytest.mark.integration
def test_personal_put_rejects_stale_publication_after_visibility_check(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner, viewer, other = (
        _actor(db, label) for label in ("stale-owner", "stale-viewer", "stale-other")
    )
    board = Board(owner_id=owner.id, name="Changing publication")
    db.add(board)
    db.flush()
    _grant(db, board, viewer)
    item, _ = _published(db, board, owner)
    db.commit()
    url = _url(board, item)
    client = _client(db, viewer)
    assert _put_read(client, url, 1, True).status_code == 200
    state = db.scalar(select(BoardAnnouncementPersonalState))
    assert state is not None

    next_revision = BoardAnnouncementRevision(
        announcement_id=item.id,
        publication_number=2,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=owner.id,
        title="Second publication",
        body="Second body",
        audience_kind="everyone",
        published_at=datetime.now(UTC),
    )
    db.add(next_revision)
    item.displayed_publication_number = 2
    db.commit()
    stale = _put_bookmark(client, url, 1, True)
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "stale_publication"
    db.refresh(state)
    assert (state.read, state.bookmarked) == (True, False)
    assert client.get(url).json()["publication_number"] == 2

    third_revision = BoardAnnouncementRevision(
        announcement_id=item.id,
        publication_number=3,
        publication_key=uuid7(),
        content_fingerprint="b" * 64,
        author_id=owner.id,
        title="Hidden publication",
        body="Hidden body",
        audience_kind="user",
        audience_user_id=other.id,
        published_at=datetime.now(UTC),
    )
    db.add(third_revision)
    item.displayed_publication_number = 3
    db.commit()
    assert client.get(url).status_code == 404
    assert _put_bookmark(client, url, 1, True).status_code == 404
    db.refresh(state)
    assert (state.read, state.bookmarked) == (True, False)


@pytest.mark.integration
def test_personal_put_rechecks_disabled_actor_and_revoked_board_view(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner, viewer = (_actor(db, label) for label in ("revocation-owner", "revocation-viewer"))
    board = Board(owner_id=owner.id, name="Revoked announcement")
    db.add(board)
    db.flush()
    grant = _grant(db, board, viewer)
    item, _ = _published(db, board, owner)
    db.commit()
    url = _url(board, item)
    client = _client(db, viewer)

    viewer.status = "disabled"
    db.commit()
    assert _put_read(client, url, 1, True).status_code == 403
    viewer.status = "active"
    grant.is_deleted = True
    db.commit()
    assert _put_bookmark(client, url, 1, True).status_code == 404
    assert db.scalar(select(func.count()).select_from(BoardAnnouncementPersonalState)) == 0


def test_batch_personal_read_rejects_missing_or_overlarge_id_list_before_board_lookup() -> None:
    db = Mock(spec=Session)
    reader = make_user("announcement_batch_reader", role="guest")
    url = f"/api/boards/{uuid7()}/announcement-personal"
    client = _client(db, reader)
    assert client.get(url).status_code == 422
    assert (
        client.get(url, params=[("announcement_id", str(uuid7())) for _ in range(26)]).status_code
        == 422
    )
    db.scalar.assert_not_called()
    db.scalars.assert_not_called()


@pytest.mark.integration
def test_batch_personal_read_keeps_order_is_private_and_uses_two_content_queries(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner, viewer, other = (
        _actor(db, label) for label in ("batch-owner", "batch-viewer", "batch-other")
    )
    board = Board(owner_id=owner.id, name="Batch personal announcements")
    db.add(board)
    db.flush()
    _grant(db, board, viewer)
    _grant(db, board, other)
    first, _ = _published(db, board, owner)
    second, _ = _published(db, board, owner)
    db.add(
        BoardAnnouncementPersonalState(
            user_id=viewer.id, announcement_id=second.id, read=True, bookmarked=True
        )
    )
    db.commit()
    url = f"/api/boards/{board.id}/announcement-personal"
    params = [("announcement_id", str(second.id)), ("announcement_id", str(first.id))]
    statements: list[str] = []
    connection = db.connection()

    def record_query(_connection, _cursor, statement, _parameters, _context, _executemany) -> None:
        statements.append(" ".join(statement.lower().split()))

    event.listen(connection, "before_cursor_execute", record_query)
    try:
        result = _client(db, viewer).get(url, params=params)
    finally:
        event.remove(connection, "before_cursor_execute", record_query)
    assert result.status_code == 200
    assert result.headers["Cache-Control"] == "private, no-store"
    assert result.json() == [
        {
            "announcement_id": str(second.id),
            "publication_number": 1,
            "read": True,
            "bookmarked": True,
        },
        {
            "announcement_id": str(first.id),
            "publication_number": 1,
            "read": False,
            "bookmarked": False,
        },
    ]
    assert (
        sum(
            "from board_announcements join board_announcement_revisions" in query
            for query in statements
        )
        == 1
    )
    assert sum("from board_announcement_personal_states" in query for query in statements) == 1
    assert _client(db, other).get(url, params=params).json() == [
        {
            "announcement_id": str(second.id),
            "publication_number": 1,
            "read": False,
            "bookmarked": False,
        },
        {
            "announcement_id": str(first.id),
            "publication_number": 1,
            "read": False,
            "bookmarked": False,
        },
    ]
    assert (
        _client(db, viewer).get(url, params=[("announcement_id", str(first.id))] * 2).status_code
        == 422
    )


@pytest.mark.integration
def test_batch_personal_read_fails_wholly_for_hidden_content_even_for_manager(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner, viewer, manager = (
        _actor(db, label)
        for label in ("batch-private-owner", "batch-private-viewer", "batch-private-manager")
    )
    board = Board(owner_id=owner.id, name="Restricted batch")
    db.add(board)
    db.flush()
    _grant(db, board, viewer)
    _grant(db, board, manager, "manage")
    visible, _ = _published(db, board, owner)
    hidden, _ = _published(db, board, owner, audience_kind="user", audience_user_id=owner.id)
    db.commit()
    url = f"/api/boards/{board.id}/announcement-personal"
    params = [("announcement_id", str(visible.id)), ("announcement_id", str(hidden.id))]
    for actor in (viewer, manager):
        result = _client(db, actor).get(url, params=params)
        assert result.status_code == 404
        assert str(visible.id) not in result.text
        assert str(hidden.id) not in result.text
