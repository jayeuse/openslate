"""External links on events and posts: bounded, redacted in audit, frozen in publications."""

from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_router import router as event_router
from app.systems.boards.event_schemas import EventCreate
from app.systems.boards.post_models import BoardPostRevision, publication_content_fingerprint
from app.systems.boards.post_router import router as post_router
from app.systems.boards.post_schemas import PostCreate
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.boards.support import client, grant, member, project_board


def _event_payload(board_revision: int, **changes: object) -> dict[str, object]:
    start = datetime(2027, 1, 4, 9, tzinfo=UTC)
    return {
        "board_revision": board_revision,
        "title": "Planning",
        "all_day": False,
        "start_at": start.isoformat().replace("+00:00", "Z"),
        "end_at": (start + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        "timezone_name": "UTC",
        **changes,
    }


def _post_payload(board_revision: int, **changes: object) -> dict[str, object]:
    return {
        "board_revision": board_revision,
        "title": "Opening notice",
        "body": "The office is open.",
        **changes,
    }


def test_external_link_contract_accepts_bounded_http_urls_and_rejects_credentials() -> None:
    link = {"label": " Guide ", "url": "https://example.org/docs?topic=boards"}
    event = EventCreate.model_validate(_event_payload(1, links=[link]))
    post = PostCreate.model_validate(_post_payload(1, links=[link]))
    assert event.links[0].label == "Guide"
    assert post.links[0].url == "https://example.org/docs?topic=boards"
    for invalid in (
        {"label": "", "url": "https://example.org"},
        {"label": "x" * 101, "url": "https://example.org"},
        {"label": "Private", "url": "https://user:password@example.org"},
        {"label": "Local", "url": "file:///etc/passwd"},
        {"label": "Unsafe", "url": "javascript:alert(1)"},
        {"label": "Long", "url": "https://example.org/" + "x" * 2048},
        {"label": "Extra", "url": "https://example.org", "owner_id": str(uuid7())},
    ):
        with pytest.raises(ValidationError):
            EventCreate.model_validate(_event_payload(1, links=[invalid]))
        with pytest.raises(ValidationError):
            PostCreate.model_validate(_post_payload(1, links=[invalid]))
    with pytest.raises(ValidationError):
        EventCreate.model_validate(_event_payload(1, links=[link] * 21))
    with pytest.raises(ValidationError):
        PostCreate.model_validate(_post_payload(1, links=[link] * 21))
    with pytest.raises(ValidationError):
        PostCreate.model_validate(_post_payload(1, audience={"kind": "everyone"}))


def test_the_publication_fingerprint_changes_with_links_and_nothing_else() -> None:
    content = {"author_id": uuid7(), "title": "Notice", "body": "Body"}
    plain = publication_content_fingerprint(**content)
    assert publication_content_fingerprint(**content, links=[]) == plain
    assert (
        publication_content_fingerprint(
            **content, links=[{"label": "Guide", "url": "https://example.org/guide"}]
        )
        != plain
    )


@pytest.mark.integration
def test_event_links_persist_and_are_redacted_in_audit(integration_owner_db: Session) -> None:
    db = integration_owner_db
    author, reader = member(db), member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    grant(db, board, [reader], AccessLevel.READ)
    db.commit()
    root = f"/api/boards/{board.id}/events"
    link = {"label": "Agenda", "url": "https://example.org/private-agenda"}
    created = client(db, author, event_router).post(
        root, json=_event_payload(board.revision, links=[link])
    )
    assert created.status_code == 201
    event_id = created.json()["id"]
    event_audit = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "board_events",
            AuditLog.entity_id == UUID(event_id),
            AuditLog.action == AuditAction.CREATE,
        )
    )
    assert event_audit is not None and event_audit.after is not None
    assert event_audit.after["links"] == "[REDACTED]"
    stored_event = db.get(BoardEvent, UUID(event_id))
    assert stored_event is not None
    savepoint = db.begin_nested()
    stored_event.links = [link] * 21
    with pytest.raises(IntegrityError):
        db.flush()
    savepoint.rollback()
    assert client(db, reader, event_router).get(f"{root}/{event_id}").json()["links"] == [link]
    replacement = {"label": "Agenda", "url": "https://example.org/private-agenda-v2"}
    db.refresh(board)
    replaced = client(db, author, event_router).patch(
        f"{root}/{event_id}",
        json={"board_revision": board.revision, "event_revision": 1, "links": [replacement]},
    )
    assert replaced.status_code == 200
    shown = client(db, reader, event_router).get(f"{root}/{event_id}").json()
    assert shown["links"] == [replacement]


@pytest.mark.integration
def test_post_links_are_immutable_in_publications_and_bind_retry_key(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    grant(db, board, [author], AccessLevel.WRITE)
    db.commit()
    api = client(db, author, post_router)
    root = f"/api/boards/{board.id}/posts"
    first_link = {"label": "Policy", "url": "https://example.org/policy-v1"}
    second_link = {"label": "Policy", "url": "https://example.org/policy-v2"}
    created = api.post(root, json=_post_payload(1, links=[first_link]))
    assert created.status_code == 201
    item_id = created.json()["id"]
    publish = {"board_revision": 2, "post_revision": 1, "publication_key": str(uuid7())}
    first = api.post(f"{root}/{item_id}/publish", json=publish)
    assert first.status_code == 200
    assert api.post(f"{root}/{item_id}/publish", json=publish).json() == first.json()
    assert api.get(f"{root}/{item_id}").json()["links"] == [first_link]
    patched = api.patch(
        f"{root}/{item_id}",
        json={"board_revision": 3, "post_revision": 2, "links": [second_link]},
    )
    assert patched.status_code == 200
    assert api.get(f"{root}/{item_id}?view=draft").json()["links"] == [second_link]
    assert api.get(f"{root}/{item_id}").json()["links"] == [first_link]
    mismatch = api.post(f"{root}/{item_id}/publish", json=publish)
    assert mismatch.status_code == 409
    assert mismatch.json()["detail"]["code"] == "publication_key_conflict"
    old_revision = db.scalar(select(BoardPostRevision).where(BoardPostRevision.post_id == item_id))
    assert old_revision is not None and old_revision.links == [first_link]
    publication_audit = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "board_post_revisions",
            AuditLog.entity_id == old_revision.id,
            AuditLog.action == AuditAction.CREATE,
        )
    )
    assert publication_audit is not None and publication_audit.after is not None
    assert publication_audit.after["links"] == "[REDACTED]"
