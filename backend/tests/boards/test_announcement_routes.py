"""Board announcement HTTP audience, publication, and lifecycle contracts."""

from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import get_current_user
from app.core.database import get_db
from app.systems.access.policy.models import AccessPolicyVersion, AccessRule
from app.systems.access.users.models import Role, User, UserDepartment
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_router import router
from app.systems.boards.announcement_schemas import AnnouncementCreate, AnnouncementSchedule
from app.systems.boards.models import Board, BoardGrant
from app.systems.sandbox.departments.models import Department
from tests.rbac.support import make_role, make_user


def _client(db: Session, actor: User) -> TestClient:
    app = FastAPI()
    app.include_router(router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: actor
    return TestClient(app)


def _actor(db: Session, label: str, *, read: bool = True, write: bool = True) -> User:
    role = Role(
        role=f"announcement-{label}-{uuid7().hex[:8]}",
        permissions={"records.read": read, "records.write": write},
    )
    db.add(role)
    db.flush()
    user_id = uuid7()
    actor = User(
        id=user_id,
        email=f"announcement-{user_id.hex}@example.test",
        username=f"announcement_{user_id.hex[:12]}",
        status="active",
        role_id=role.id,
        role=role,
    )
    db.add(actor)
    db.flush()
    return actor


def _board(db: Session, owner: User) -> Board:
    board = Board(owner_id=owner.id, name=f"Announcement Board {uuid7().hex[:8]}")
    db.add(board)
    db.flush()
    return board


def _grant(db: Session, board: Board, actor: User, permission: str) -> None:
    db.add(
        BoardGrant(
            board_id=board.id,
            principal_type="user",
            principal_user_id=actor.id,
            permission=permission,
            effect="allow",
        )
    )


def _create_payload(board_revision: int, **changes: object) -> dict[str, object]:
    return {
        "board_revision": board_revision,
        "title": "Opening notice",
        "body": "The office is open.",
        "audience": {"kind": "everyone"},
        **changes,
    }


def test_announcement_routes_require_global_capabilities_before_board_lookup() -> None:
    reader = make_user("announcement_reader", role=make_role("member", {"records.read": True}))
    writer = make_user("announcement_writer", role=make_role("member", {"records.write": True}))
    db = Mock(spec=Session)
    board_id, announcement_id = uuid7(), uuid7()
    root = f"/api/boards/{board_id}/announcements"

    assert _client(db, writer).get(root).status_code == 403
    assert _client(db, reader).post(root, json=_create_payload(1)).status_code == 403
    assert (
        _client(db, reader)
        .post(
            f"{root}/{announcement_id}/publish",
            json={"board_revision": 1, "announcement_revision": 1, "publication_key": str(uuid7())},
        )
        .status_code
        == 403
    )
    db.scalar.assert_not_called()
    db.scalars.assert_not_called()


def test_announcement_input_rejects_ambiguous_audiences_and_non_utc_timing() -> None:
    valid = _create_payload(1)
    assert AnnouncementCreate.model_validate(valid).title == "Opening notice"
    for candidate in (
        {**valid, "audience": {"kind": "role"}},
        {**valid, "audience": {"kind": "everyone", "user_id": str(uuid7())}},
        {**valid, "title": "  "},
        {**valid, "body": "x" * 2001},
        {**valid, "expires_at": "2026-09-24T10:00:00+08:00"},
        {**valid, "attachments": []},
    ):
        with pytest.raises(ValidationError):
            AnnouncementCreate.model_validate(candidate)
    with pytest.raises(ValidationError):
        AnnouncementSchedule.model_validate(
            {"board_revision": 1, "announcement_revision": 1, "publish_at": "2026-09-25T10:00:00"}
        )


@pytest.mark.integration
def test_announcement_published_and_draft_queries_prefilter_audience_for_managers(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "scope-owner")
    published_manager = _actor(db, "published-manager")
    draft_manager = _actor(db, "draft-manager")
    outsider = _actor(db, "scope-outsider")
    board = _board(db, owner)
    _grant(db, board, published_manager, "manage")
    _grant(db, board, draft_manager, "manage")
    department = Department(department_name=f"Announcement Department {uuid7().hex}")
    db.add(department)
    db.flush()
    db.add(UserDepartment(user_id=draft_manager.id, department_id=department.id))
    now = datetime.now(UTC)
    announcement = BoardAnnouncement(
        board_id=board.id,
        author_id=owner.id,
        title="Private replacement",
        body="Next restricted body",
        status="scheduled",
        publish_at=now + timedelta(days=2),
        audience_kind="department",
        audience_department_id=department.id,
        displayed_publication_number=1,
    )
    db.add(announcement)
    db.flush()
    revision = BoardAnnouncementRevision(
        announcement_id=announcement.id,
        publication_number=1,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=owner.id,
        title="Earlier published title",
        body="Earlier published body",
        audience_kind="user",
        audience_user_id=published_manager.id,
        published_at=now - timedelta(days=1),
    )
    db.add(revision)
    db.commit()
    root = f"/api/boards/{board.id}/announcements"

    published = _client(db, published_manager).get(f"{root}?view=published&limit=1")
    assert published.status_code == 200
    assert published.headers["Cache-Control"] == "private, no-store"
    assert published.json()["pagination"]["total"] == 1
    assert published.json()["items"][0]["title"] == "Earlier published title"
    assert published.json()["items"][0]["announcement_revision"] is None
    assert published.json()["items"][0]["audience"]["user_id"] == str(published_manager.id)
    assert (
        _client(db, published_manager)
        .get(f"{root}?view=published&search=Private%20replacement")
        .json()["pagination"]["total"]
        == 0
    )
    assert (
        _client(db, published_manager)
        .get(f"{root}?view=published&search=Earlier%20published")
        .json()["pagination"]["total"]
        == 1
    )
    assert (
        _client(db, published_manager).get(f"{root}?view=draft").json()["pagination"]["total"] == 0
    )
    assert (
        _client(db, draft_manager).get(f"{root}?view=published").json()["pagination"]["total"] == 0
    )
    assert _client(db, draft_manager).get(f"{root}?view=draft").json()["pagination"]["total"] == 1
    own_drafts = _client(db, owner).get(f"{root}?view=draft")
    assert own_drafts.status_code == 200
    assert own_drafts.json()["pagination"]["total"] == 1
    assert own_drafts.json()["items"][0]["id"] == str(announcement.id)
    own_draft = _client(db, owner).get(f"{root}/{announcement.id}?view=draft")
    assert own_draft.status_code == 200
    assert own_draft.json()["id"] == str(announcement.id)
    assert own_draft.json()["audience"]["kind"] == "department"
    assert _client(db, owner).get(f"{root}?view=published").json()["pagination"]["total"] == 0
    assert _client(db, outsider).get(root).status_code == 404
    for actor, view in ((published_manager, "draft"), (draft_manager, "published")):
        response = _client(db, actor).get(f"{root}/{announcement.id}?view={view}")
        assert response.status_code == 404
    assert (
        _client(db, published_manager)
        .post(
            f"{root}/{announcement.id}/archive",
            json={"board_revision": board.revision, "announcement_revision": announcement.revision},
        )
        .status_code
        == 404
    )
    assert (
        _client(db, draft_manager)
        .post(
            f"{root}/{announcement.id}/archive",
            json={"board_revision": board.revision, "announcement_revision": announcement.revision},
        )
        .status_code
        == 404
    )


@pytest.mark.integration
def test_announcement_author_can_reload_and_edit_published_content_outside_recipient_audience(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = _actor(db, "editable-author")
    recipient = _actor(db, "editable-recipient")
    excluded_manager = _actor(db, "editable-manager")
    read_only_author = _actor(db, "editable-read-only", write=False)
    board = _board(db, author)
    _grant(db, board, recipient, "view")
    _grant(db, board, excluded_manager, "manage")
    _grant(db, board, read_only_author, "edit")
    db.commit()
    root = f"/api/boards/{board.id}/announcements"
    author_client = _client(db, author)
    created = author_client.post(
        root,
        json=_create_payload(1, audience={"kind": "user", "user_id": str(recipient.id)}),
    )
    assert created.status_code == 201
    item_id = created.json()["id"]
    published = author_client.post(
        f"{root}/{item_id}/publish",
        json={
            "board_revision": 2,
            "announcement_revision": 1,
            "publication_key": str(uuid7()),
        },
    )
    assert published.status_code == 200

    # The recipient feed must not become an authoring escape hatch.
    assert author_client.get(f"{root}?view=published").json()["pagination"]["total"] == 0
    assert (
        _client(db, excluded_manager).get(f"{root}?view=published").json()["pagination"]["total"]
        == 0
    )
    assert _client(db, recipient).get(f"{root}?view=published").json()["pagination"]["total"] == 1

    # Workspace Record denial does not revoke this Board author's text editor.
    version = db.scalar(select(AccessPolicyVersion).with_for_update())
    assert version is not None
    version.revision += 1
    db.add(
        AccessRule(
            subject_kind="user",
            subject_id=author.id,
            scope_kind="workspace",
            scope_id=None,
            permission_id="records.write",
            decision="deny",
            starts_at=None,
            ends_at=None,
            locked=False,
            policy_version=version.revision,
        )
    )
    db.commit()

    reloaded_author = _client(db, author)
    own = reloaded_author.get(f"{root}?view=editable")
    assert own.status_code == 200
    assert own.json()["pagination"]["total"] == 1
    assert own.json()["items"][0]["id"] == item_id
    assert own.json()["items"][0]["announcement_revision"] == 2
    detail = reloaded_author.get(f"{root}/{item_id}?view=editable")
    assert detail.status_code == 200
    assert detail.json()["title"] == "Opening notice"
    changed = reloaded_author.patch(
        f"{root}/{item_id}",
        json={"board_revision": 3, "announcement_revision": 2, "title": "New author draft"},
    )
    assert changed.status_code == 200
    assert changed.json()["board_revision"] == 4
    assert _client(db, recipient).get(f"{root}/{item_id}?view=published").json()[
        "title"
    ] == "Opening notice"
    republished = reloaded_author.post(
        f"{root}/{item_id}/publish",
        json={
            "board_revision": 4,
            "announcement_revision": 3,
            "publication_key": str(uuid7()),
        },
    )
    assert republished.status_code == 200
    assert _client(db, recipient).get(f"{root}/{item_id}?view=published").json()[
        "title"
    ] == "New author draft"
    assert reloaded_author.get(f"{root}?view=published").json()["pagination"]["total"] == 0

    manager_client = _client(db, excluded_manager)
    assert manager_client.get(f"{root}?view=editable").json()["pagination"]["total"] == 0
    assert manager_client.get(f"{root}/{item_id}?view=editable").status_code == 404
    assert _client(db, recipient).get(f"{root}?view=editable").status_code == 404
    assert _client(db, read_only_author).get(f"{root}?view=editable").status_code == 403


@pytest.mark.integration
def test_announcement_publication_retry_and_archive_delete_preserve_snapshot_rules(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "lifecycle-owner")
    manager = _actor(db, "lifecycle-manager")
    board = _board(db, owner)
    _grant(db, board, manager, "manage")
    db.commit()
    root = f"/api/boards/{board.id}/announcements"
    owner_client, manager_client = _client(db, owner), _client(db, manager)

    created = owner_client.post(root, json=_create_payload(1))
    assert created.status_code == 201
    announcement_id = created.json()["id"]
    assert created.json() == {
        "id": announcement_id,
        "announcement_revision": 1,
        "board_revision": 2,
    }
    assert created.headers["Location"] == f"{root}/{announcement_id}?view=draft"
    key = uuid7()
    publish_body = {"board_revision": 2, "announcement_revision": 1, "publication_key": str(key)}
    first = owner_client.post(f"{root}/{announcement_id}/publish", json=publish_body)
    assert first.status_code == 200
    assert first.json()["publication_key"] == str(key)
    assert (
        owner_client.post(f"{root}/{announcement_id}/publish", json=publish_body).json()
        == first.json()
    )
    cross_actor_replay = manager_client.post(f"{root}/{announcement_id}/publish", json=publish_body)
    assert cross_actor_replay.status_code == 409
    assert cross_actor_replay.json()["detail"]["code"] == "publication_key_conflict"
    old_revision = db.scalar(
        select(BoardAnnouncementRevision).where(
            BoardAnnouncementRevision.announcement_id == announcement_id
        )
    )
    assert old_revision is not None
    assert old_revision.title == "Opening notice"

    changed = owner_client.patch(
        f"{root}/{announcement_id}",
        json={
            "board_revision": 3,
            "announcement_revision": 2,
            "title": "Restricted replacement",
            "audience": {"kind": "user", "user_id": str(manager.id)},
        },
    )
    assert changed.status_code == 200
    assert changed.json()["board_revision"] == 4
    assert owner_client.get(f"{root}/{announcement_id}?view=draft").json()["title"] == (
        "Restricted replacement"
    )
    assert owner_client.get(f"{root}/{announcement_id}?view=published").status_code == 200
    mismatch = manager_client.post(
        f"{root}/{announcement_id}/publish",
        json={"board_revision": 4, "announcement_revision": 3, "publication_key": str(key)},
    )
    assert mismatch.status_code == 409
    assert mismatch.json()["detail"]["code"] == "publication_key_conflict"

    scheduled_at = datetime.now(UTC) + timedelta(days=2)
    scheduled = manager_client.post(
        f"{root}/{announcement_id}/schedule",
        json={
            "board_revision": 4,
            "announcement_revision": 3,
            "publish_at": scheduled_at.isoformat(),
        },
    )
    assert scheduled.status_code == 200
    assert scheduled.json()["board_revision"] == 5
    still_published = manager_client.get(f"{root}/{announcement_id}?view=published")
    assert still_published.status_code == 200
    assert still_published.json()["title"] == "Opening notice"
    assert manager_client.get(f"{root}/{announcement_id}?view=draft").json()["title"] == (
        "Restricted replacement"
    )
    assert db.get(BoardAnnouncementRevision, old_revision.id).title == "Opening notice"

    unpublished = manager_client.post(
        f"{root}/{announcement_id}/unpublish",
        json={"board_revision": 5, "announcement_revision": 4},
    )
    assert unpublished.status_code == 200
    assert manager_client.get(f"{root}/{announcement_id}?view=published").status_code == 404
    assert db.get(BoardAnnouncementRevision, old_revision.id) is not None
    archived = manager_client.post(
        f"{root}/{announcement_id}/archive",
        json={"board_revision": 6, "announcement_revision": 5},
    )
    assert archived.status_code == 200
    assert manager_client.get(f"{root}?view=archive").json()["pagination"]["total"] == 1
    restored = manager_client.post(
        f"{root}/{announcement_id}/restore",
        json={"board_revision": 7, "announcement_revision": 6},
    )
    assert restored.status_code == 200
    assert manager_client.get(f"{root}/{announcement_id}?view=draft").status_code == 200
    assert (
        manager_client.request(
            "DELETE",
            f"{root}/{announcement_id}",
            json={"board_revision": 8, "announcement_revision": 7},
        ).json()["detail"]["code"]
        == "announcement_not_archived"
    )
    assert (
        manager_client.post(
            f"{root}/{announcement_id}/archive",
            json={"board_revision": 8, "announcement_revision": 7},
        ).status_code
        == 200
    )
    removed = manager_client.request(
        "DELETE",
        f"{root}/{announcement_id}",
        json={"board_revision": 9, "announcement_revision": 8},
    )
    assert removed.status_code == 204
    assert removed.headers["Cache-Control"] == "private, no-store"
    assert db.get(BoardAnnouncement, announcement_id) is None
    assert db.get(BoardAnnouncementRevision, old_revision.id) is None


@pytest.mark.integration
def test_announcement_rejects_stale_inactive_and_unmanaged_writes_without_partial_changes(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "failure-owner")
    editor = _actor(db, "failure-editor")
    other_editor = _actor(db, "failure-other-editor")
    manager = _actor(db, "failure-manager")
    expired_user = _actor(db, "failure-expired-user")
    board = _board(db, owner)
    for actor, permission in ((editor, "edit"), (other_editor, "edit"), (manager, "manage")):
        _grant(db, board, actor, permission)
    inactive = Role(role=f"inactive-announcement-{uuid7().hex}", permissions={})
    db.add(inactive)
    db.flush()
    inactive.is_deleted = True
    expired_user.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db.commit()
    root = f"/api/boards/{board.id}/announcements"
    client = _client(db, editor)

    unavailable = client.post(
        root,
        json=_create_payload(1, audience={"kind": "role", "role_id": str(inactive.id)}),
    )
    assert unavailable.status_code == 409
    assert unavailable.json()["detail"]["code"] == "audience_unavailable"
    expired_target = client.post(
        root,
        json=_create_payload(1, audience={"kind": "user", "user_id": str(expired_user.id)}),
    )
    assert expired_target.status_code == 409
    assert expired_target.json()["detail"]["code"] == "audience_unavailable"
    assert (
        db.scalars(select(BoardAnnouncement.id).where(BoardAnnouncement.board_id == board.id)).all()
        == []
    )
    created = client.post(root, json=_create_payload(1))
    assert created.status_code == 201
    item_id = created.json()["id"]

    assert (
        _client(db, other_editor)
        .patch(
            f"{root}/{item_id}",
            json={"board_revision": 2, "announcement_revision": 1, "title": "Not mine"},
        )
        .status_code
        == 404
    )
    assert (
        client.post(
            f"{root}/{item_id}/archive",
            json={"board_revision": 2, "announcement_revision": 1},
        ).status_code
        == 404
    )
    stale_board = client.patch(
        f"{root}/{item_id}",
        json={"board_revision": 1, "announcement_revision": 1, "title": "Stale board"},
    )
    assert stale_board.status_code == 409
    assert stale_board.json()["detail"]["code"] == "stale_board_revision"
    stale_announcement = client.patch(
        f"{root}/{item_id}",
        json={"board_revision": 2, "announcement_revision": 2, "title": "Stale item"},
    )
    assert stale_announcement.status_code == 409
    assert stale_announcement.json()["detail"]["code"] == "stale_announcement_revision"
    past = client.post(
        f"{root}/{item_id}/schedule",
        json={
            "board_revision": 2,
            "announcement_revision": 1,
            "publish_at": (datetime.now(UTC) - timedelta(days=1)).isoformat(),
        },
    )
    assert past.status_code == 422
    assert past.json()["detail"]["code"] == "announcement_schedule_invalid"
    assert db.get(BoardAnnouncement, item_id).title == "Opening notice"
    assert db.get(BoardAnnouncement, item_id).revision == 1
    assert db.get(Board, board.id).revision == 2
    managed = _client(db, manager).patch(
        f"{root}/{item_id}",
        json={"board_revision": 2, "announcement_revision": 1, "title": "Manager edit"},
    )
    assert managed.status_code == 200


@pytest.mark.integration
def test_published_list_orders_by_displayed_revision_not_unpublished_draft_timestamps(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = _actor(db, "order-owner")
    reader = _actor(db, "order-reader", write=False)
    board = _board(db, owner)
    _grant(db, board, reader, "view")
    now = datetime.now(UTC)
    early_parent = BoardAnnouncement(
        board_id=board.id,
        author_id=owner.id,
        title="B visible",
        body="B body",
        audience_kind="everyone",
        status="published",
        displayed_publication_number=1,
        created_at=now - timedelta(days=6),
        updated_at=now - timedelta(days=2),
    )
    later_parent_with_draft = BoardAnnouncement(
        board_id=board.id,
        author_id=owner.id,
        title="Private unpublished edit",
        body="New private body",
        audience_kind="everyone",
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
            BoardAnnouncementRevision(
                announcement_id=parent.id,
                publication_number=1,
                publication_key=uuid7(),
                content_fingerprint="a" * 64,
                author_id=owner.id,
                title=title,
                body="Public body",
                audience_kind="everyone",
                published_at=published_at,
                created_at=published_at,
                updated_at=published_at,
            )
        )
    db.commit()
    client = _client(db, reader)
    for suffix, expected in (
        ("", early_parent.id),
        ("&sort_by=updated_at&sort_order=desc", early_parent.id),
        ("&sort_by=created_at&sort_order=asc", later_parent_with_draft.id),
    ):
        result = client.get(f"/api/boards/{board.id}/announcements?view=published&limit=1{suffix}")
        assert result.status_code == 200 and result.json()["pagination"]["total"] == 2
        assert result.json()["items"][0]["id"] == str(expected)
