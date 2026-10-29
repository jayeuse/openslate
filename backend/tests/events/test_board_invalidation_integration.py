"""Opaque Board invalidations across creation, purge phases, commit and rollback."""

from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.users.models import UserRole
from app.systems.boards.models import Board, BoardScope
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.manage.audit.listeners import REALTIME_INVALIDATION_KEY
from app.systems.platform.events.models import InvalidationEvent
from tests.rbac.support import add_user, organization

pytestmark = pytest.mark.integration


def _board_payloads(db: Session) -> list[dict[str, str]]:
    return [
        event.to_payload()
        for event in db.info.get(REALTIME_INVALIDATION_KEY, [])
        if event.entity.startswith("board")
    ]


def test_new_board_scope_and_deleted_parent_chain_survive_flushes_and_commit_deduplicates(
    integration_db: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db = integration_db
    author = add_user(db, role=UserRole.ADMIN)
    board = Board(org_id=organization(db).id,
                  scope=BoardScope.PROJECT, name=f"Events {uuid7()}")
    db.add(board)
    db.flush()
    board_id = board.id
    post = BoardPost(
        org_id=board.org_id,
        id=uuid7(), board_id=board_id, author_id=author.id, title="Count", body="Today"
    )
    revision = BoardPostRevision(
        org_id=post.org_id,
        id=uuid7(),
        post_id=post.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=author.id,
        title="Count",
        body="Today",
        published_at=datetime.now(UTC),
    )
    db.add_all([post, revision])
    db.flush()
    assert sorted(_board_payloads(db), key=lambda payload: payload["entity"]) == [
        {"entity": "board_posts", "board_id": str(board_id)},
        {"entity": "board_posts", "board_id": str(board_id)},
        {"entity": "boards", "board_id": str(board_id)},
    ]
    db.info.pop(REALTIME_INVALIDATION_KEY, None)
    # Match the purge phases: RESTRICT foreign keys require descendants first.
    db.delete(revision)
    db.flush()
    db.delete(post)
    db.flush()
    db.delete(board)
    db.flush()
    assert {tuple(sorted(payload.items())) for payload in _board_payloads(db)} == {
        tuple(sorted({"entity": entity, "board_id": str(board_id)}.items()))
        for entity in ("boards", "board_posts")
    }
    published: list[InvalidationEvent] = []
    monkeypatch.setattr(
        "app.systems.manage.audit.listeners.publish_invalidations",
        lambda events, **_kwargs: published.extend(events),
    )
    assert published == []
    db.commit()
    assert sorted(
        [event.to_payload() for event in published], key=lambda payload: payload["entity"]
    ) == [
        {"entity": "board_posts", "board_id": str(board_id)},
        {"entity": "boards", "board_id": str(board_id)},
    ]
    assert REALTIME_INVALIDATION_KEY not in db.info

    board = Board(org_id=organization(db).id,
                  scope=BoardScope.PROJECT, name=f"Rollback {uuid7()}")
    db.add(board)
    db.flush()
    assert _board_payloads(db) == [{"entity": "boards", "board_id": str(board.id)}]
    published.clear()
    db.rollback()
    assert REALTIME_INVALIDATION_KEY not in db.info
    assert published == []
