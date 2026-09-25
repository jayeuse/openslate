"""External links stay within their Event or Announcement audience and snapshot."""

from uuid import UUID

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.boards.announcement_models import (
    BoardAnnouncementRevision,
    publication_content_fingerprint,
)
from app.systems.boards.announcement_schemas import AnnouncementCreate
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.event_schemas import EventCreate
from app.systems.manage.audit.models import AuditAction, AuditLog
from tests.boards.test_announcement_routes import (
    _actor as announcement_actor,
)
from tests.boards.test_announcement_routes import (
    _board as announcement_board,
)
from tests.boards.test_announcement_routes import (
    _client as announcement_client,
)
from tests.boards.test_announcement_routes import (
    _create_payload,
)
from tests.boards.test_announcement_routes import (
    _grant as announcement_grant,
)
from tests.boards.test_event_routes import _actor as event_actor
from tests.boards.test_event_routes import _board as event_board
from tests.boards.test_event_routes import _client as event_client
from tests.boards.test_event_routes import _grant as event_grant
from tests.boards.test_event_routes import _payload as event_payload


def test_external_link_contract_accepts_bounded_http_urls_and_rejects_credentials() -> None:
    link = {"label": " Guide ", "url": "https://example.org/docs?topic=boards"}
    event = EventCreate.model_validate({**event_payload(1), "links": [link]})
    announcement = AnnouncementCreate.model_validate(_create_payload(1, links=[link]))
    assert event.links[0].label == "Guide"
    assert announcement.links[0].url == "https://example.org/docs?topic=boards"
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
            EventCreate.model_validate({**event_payload(1), "links": [invalid]})
        with pytest.raises(ValidationError):
            AnnouncementCreate.model_validate(_create_payload(1, links=[invalid]))
    with pytest.raises(ValidationError):
        EventCreate.model_validate({**event_payload(1), "links": [link] * 21})
    with pytest.raises(ValidationError):
        AnnouncementCreate.model_validate(_create_payload(1, links=[link] * 21))


def test_empty_links_preserve_legacy_publication_fingerprint() -> None:
    content = {
        "author_id": uuid7(),
        "title": "Earlier notice",
        "body": "Published before links",
        "audience_kind": "everyone",
    }
    old_fingerprint = publication_content_fingerprint(**content)
    assert publication_content_fingerprint(**content, links=[]) == old_fingerprint
    assert (
        publication_content_fingerprint(
            **content,
            links=[{"label": "Guide", "url": "https://example.org/guide"}],
        )
        != old_fingerprint
    )


@pytest.mark.integration
def test_event_links_persist_but_never_leak_past_event_audience(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = event_actor(db, "link-owner")
    viewer = event_actor(db, "link-viewer")
    manager = event_actor(db, "link-manager")
    board = event_board(db, owner)
    event_grant(db, board, viewer, "view")
    event_grant(db, board, manager, "manage")
    db.commit()
    root = f"/api/boards/{board.id}/events"
    link = {"label": "Agenda", "url": "https://example.org/private-agenda"}
    created = event_client(db, owner).post(root, json={**event_payload(1), "links": [link]})
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
    with pytest.raises(IntegrityError):
        with db.begin_nested():
            stored_event.links = [link] * 21
            db.flush()
    assert event_client(db, viewer).get(f"{root}/{event_id}").json()["links"] == [link]
    replacement = {"label": "Agenda", "url": "https://example.org/private-agenda-v2"}
    replaced = event_client(db, owner).patch(
        f"{root}/{event_id}",
        json={"board_revision": 2, "event_revision": 1, "links": [replacement]},
    )
    assert replaced.status_code == 200
    assert event_client(db, viewer).get(f"{root}/{event_id}").json()["links"] == [replacement]
    patched = event_client(db, owner).patch(
        f"{root}/{event_id}",
        json={
            "board_revision": 3,
            "event_revision": 2,
            "audience": {"kind": "user", "user_id": str(viewer.id)},
        },
    )
    assert patched.status_code == 200
    hidden_list = event_client(db, manager).get(root)
    assert hidden_list.status_code == 200
    assert hidden_list.json()["pagination"]["total"] == 0
    assert "private-agenda" not in hidden_list.text
    assert event_client(db, manager).get(f"{root}/{event_id}").status_code == 404
    assert event_client(db, viewer).get(f"{root}/{event_id}").json()["links"] == [replacement]


@pytest.mark.integration
def test_announcement_links_are_immutable_in_publications_and_bind_retry_key(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = announcement_actor(db, "link-owner")
    manager = announcement_actor(db, "link-manager")
    board = announcement_board(db, owner)
    announcement_grant(db, board, manager, "manage")
    db.commit()
    root = f"/api/boards/{board.id}/announcements"
    first_link = {"label": "Policy", "url": "https://example.org/policy-v1"}
    second_link = {"label": "Policy", "url": "https://example.org/policy-v2"}
    created = announcement_client(db, owner).post(
        root,
        json=_create_payload(
            1,
            links=[first_link],
            audience={"kind": "role", "role_id": str(owner.role_id)},
        ),
    )
    assert created.status_code == 201
    item_id = created.json()["id"]
    key = uuid7()
    publish = {
        "board_revision": 2,
        "announcement_revision": 1,
        "publication_key": str(key),
    }
    first = announcement_client(db, owner).post(f"{root}/{item_id}/publish", json=publish)
    assert first.status_code == 200
    retry = announcement_client(db, owner).post(f"{root}/{item_id}/publish", json=publish)
    assert retry.json() == first.json()
    assert announcement_client(db, owner).get(f"{root}/{item_id}").json()["links"] == [first_link]
    hidden_page = announcement_client(db, manager).get(root)
    assert hidden_page.status_code == 200
    assert hidden_page.json()["pagination"]["total"] == 0
    assert "policy-v1" not in hidden_page.text
    assert announcement_client(db, manager).get(f"{root}/{item_id}").status_code == 404
    patched = announcement_client(db, owner).patch(
        f"{root}/{item_id}",
        json={"board_revision": 3, "announcement_revision": 2, "links": [second_link]},
    )
    assert patched.status_code == 200
    current_draft = announcement_client(db, owner).get(f"{root}/{item_id}?view=draft")
    assert current_draft.json()["links"] == [second_link]
    assert announcement_client(db, owner).get(f"{root}/{item_id}").json()["links"] == [first_link]
    mismatch = announcement_client(db, owner).post(f"{root}/{item_id}/publish", json=publish)
    assert mismatch.status_code == 409
    assert mismatch.json()["detail"]["code"] == "publication_key_conflict"
    old_revision = db.scalar(
        select(BoardAnnouncementRevision).where(
            BoardAnnouncementRevision.announcement_id == item_id
        )
    )
    assert old_revision is not None and old_revision.links == [first_link]
    publication_audit = db.scalar(
        select(AuditLog).where(
            AuditLog.entity_type == "board_announcement_revisions",
            AuditLog.entity_id == old_revision.id,
            AuditLog.action == AuditAction.CREATE,
        )
    )
    assert publication_audit is not None and publication_audit.after is not None
    assert publication_audit.after["links"] == "[REDACTED]"
