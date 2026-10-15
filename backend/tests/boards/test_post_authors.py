"""Published author choices derive only from visible posts and active identities."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.users.models import User, UserStatus
from app.systems.boards.models import Board
from app.systems.boards.post_author_router import router
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from tests.boards.support import client as board_client
from tests.boards.support import grant, member, writable_board
from tests.conftest import create_member
from tests.rbac.support import organization

pytestmark = pytest.mark.integration


def _published(
    db: Session,
    board: Board,
    author: User,
    *,
    status: str = "published",
    expires_at: datetime | None = None,
    published_at: datetime | None = None,
) -> BoardPost:
    item = BoardPost(
        board_id=board.id,
        author_id=author.id,
        title="Private post title",
        body="Private post body",
        status=status,
        displayed_publication_number=1,
    )
    db.add(item)
    db.flush()
    db.add(
        BoardPostRevision(
            post_id=item.id,
            publication_number=1,
            publication_key=uuid7(),
            content_fingerprint="a" * 64,
            author_id=author.id,
            title="Published private title",
            body="Published private body",
            published_at=published_at or datetime.now(UTC) - timedelta(days=2),
            expires_at=expires_at,
        )
    )
    db.flush()
    return item


def test_authors_are_distinct_ordered_and_only_from_visible_publications(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = member(db, "authors-owner")
    viewer = member(db, "authors-viewer")
    visible_a = member(db, "authors-a")
    visible_b = member(db, "authors-b")
    hidden = member(db, "authors-hidden")
    expired = member(db, "authors-expired")
    board = writable_board(db, owner)
    grant(db, board, [viewer], "read")
    _published(db, board, visible_b)
    _published(db, board, visible_a)
    _published(db, board, visible_a)
    _published(db, board, hidden, status="archived")
    _published(db, board, expired, expires_at=datetime.now(UTC) - timedelta(days=1))
    db.commit()

    response = board_client(db, viewer, router).get(f"/api/boards/{board.id}/post-authors")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.json()["items"] == sorted(
        [
            {"id": str(visible_a.id), "label": visible_a.username},
            {"id": str(visible_b.id), "label": visible_b.username},
        ],
        key=lambda choice: (choice["label"], choice["id"]),
    )
    assert "Private post" not in response.text
    assert "Published private" not in response.text
    assert str(hidden.id) not in response.text


def test_managers_also_see_the_authors_of_expired_posts(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = member(db, "authors-manager-owner")
    manager = member(db, "authors-manager")
    expired = member(db, "authors-manager-expired")
    board = writable_board(db, owner)
    grant(db, board, [manager], "manage")
    _published(db, board, expired, expires_at=datetime.now(UTC) - timedelta(days=1))
    db.commit()

    response = board_client(db, manager, router).get(f"/api/boards/{board.id}/post-authors")
    assert response.status_code == 200
    assert response.json()["items"] == [{"id": str(expired.id), "label": expired.username}]
    lookup = board_client(db, manager, router).get(
        f"/api/boards/{board.id}/post-authors", params={"ids": str(expired.id)}
    )
    assert lookup.status_code == 200
    assert lookup.json() == response.json()


def test_inactive_deleted_or_unestablished_authors_are_not_choices(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = member(db, "authors-active-owner")
    viewer = member(db, "authors-active-viewer")
    active = member(db, "authors-active")
    disabled = member(db, "authors-disabled")
    deleted = member(db, "authors-deleted")
    unestablished = member(db, "authors-unestablished")
    board = writable_board(db, owner)
    grant(db, board, [viewer], "read")
    for author in (active, disabled, deleted, unestablished):
        _published(db, board, author)
    disabled.status = UserStatus.DISABLED.value
    deleted.is_deleted = True
    deleted.deleted_at = datetime.now(UTC)
    unestablished.invitation_sent_at = datetime.now(UTC)
    db.commit()

    response = board_client(db, viewer, router).get(f"/api/boards/{board.id}/post-authors")
    assert response.status_code == 200
    assert response.json()["items"] == [{"id": str(active.id), "label": active.username}]


def test_missing_board_access_does_not_reveal_authors(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = member(db, "authors-denial-owner")
    outsider = member(db, "authors-denial-outsider")
    board = writable_board(db, owner)
    _published(db, board, owner)
    db.commit()
    endpoint = f"/api/boards/{board.id}/post-authors"

    assert board_client(db, outsider, router).get(endpoint).status_code == 404
    assert (
        board_client(db, outsider, router).get(endpoint, params={"ids": str(owner.id)}).status_code
        == 404
    )


def test_author_choices_page_every_visible_author_without_a_global_cap(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = member(db, "authors-bounded-owner")
    board = writable_board(db, owner)
    role = "member"
    db.flush()
    for index in range(501):
        author_id = uuid7()
        author, _membership = create_member(db, organization(db),
            id=author_id,
            email=f"authors-bounded-{author_id.hex}@example.test",
            username=f"authors_bounded_{index:03d}",
            status="active",
            role=role,
        )
        db.add(author)
        db.flush()
        _published(db, board, author)
    db.commit()

    client = board_client(db, owner, router)
    endpoint = f"/api/boards/{board.id}/post-authors"
    response = client.get(endpoint, params={"limit": 100})
    assert response.status_code == 200
    body = response.json()
    assert body["pagination"] == {
        "limit": 100,
        "offset": 0,
        "count": 100,
        "total": 501,
        "has_more": True,
    }
    assert body["items"][0]["label"] == "authors_bounded_000"
    assert body["items"][-1]["label"] == "authors_bounded_099"
    last = client.get(endpoint, params={"limit": 100, "offset": 500}).json()
    assert [item["label"] for item in last["items"]] == ["authors_bounded_500"]
    assert last["pagination"]["total"] == 501
    assert last["pagination"]["has_more"] is False


def test_author_search_uses_display_names_and_usernames_with_stable_pages(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = member(db, "authors-search-owner")
    board = writable_board(db, owner)
    named = [member(db, "authors-search-named") for _ in range(2)]
    fallback = member(db, "authors-search-fallback")
    decoy = member(db, "authors-search-decoy")
    for author in named:
        author.display_name = "Adrian 50%_team"
    decoy.display_name = "Adrian 50XXteam"
    for author in [*named, fallback, decoy]:
        _published(db, board, author)
    db.commit()
    client = board_client(db, owner, router)
    endpoint = f"/api/boards/{board.id}/post-authors"

    pages = [
        client.get(endpoint, params={"search": " ADRIAN 50%_ ", "limit": 1, "offset": offset})
        for offset in range(2)
    ]
    assert all(response.status_code == 200 for response in pages)
    assert [response.json()["items"][0]["id"] for response in pages] == [
        str(author.id) for author in sorted(named, key=lambda author: author.id)
    ]
    for offset, response in enumerate(pages):
        body = response.json()
        assert body["items"][0]["label"] == "Adrian 50%_team"
        assert body["pagination"]["total"] == 2
        assert body["pagination"]["has_more"] is (offset == 0)
    for author in [named[0], fallback]:
        response = client.get(endpoint, params={"search": author.username})
        assert response.status_code == 200
        assert response.json()["items"] == [
            {"id": str(author.id), "label": author.display_name or author.username}
        ]
    empty = client.get(endpoint, params={"search": "absent-author"}).json()
    assert empty["items"] == []
    assert empty["pagination"]["total"] == 0
    assert empty["pagination"]["has_more"] is False


@pytest.mark.parametrize(
    "params",
    [
        {"limit": 101},
        {"sort_by": "unknown"},
        {"deleted": "include"},
        {"deleted": "only"},
    ],
)
def test_author_list_rejects_invalid_or_unsupported_parameters(
    integration_owner_db: Session, params: dict[str, int | str]
) -> None:
    db = integration_owner_db
    owner = member(db, "authors-params-owner")
    board = writable_board(db, owner)
    db.commit()

    response = board_client(db, owner, router).get(
        f"/api/boards/{board.id}/post-authors", params=params
    )

    assert response.status_code == 422


def test_author_ids_intersect_visible_eligible_authors_before_search_and_paging(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    owner = member(db, "authors-lookup-owner")
    viewer = member(db, "authors-lookup-reader")
    board = writable_board(db, owner)
    grant(db, board, [viewer], "read")
    requested = [member(db, "authors-lookup-choice") for _ in range(2)]
    for author in requested:
        author.display_name = "Lookup same label"
        _published(db, board, author)
    _published(db, board, requested[0])
    decoy = member(db, "authors-lookup-decoy")
    decoy.display_name = "Lookup same label"
    _published(db, board, decoy)
    unavailable = {
        state: member(db, f"authors-lookup-{state}")
        for state in (
            "archived",
            "expired-post",
            "expired-user",
            "disabled",
            "deleted",
            "unestablished",
            "other-board",
            "no-post",
        )
    }
    past = datetime.now(UTC) - timedelta(days=1)
    for state, author in unavailable.items():
        if state == "no-post":
            continue
        _published(
            db,
            writable_board(db, owner) if state == "other-board" else board,
            author,
            status="archived" if state == "archived" else "published",
            expires_at=past if state == "expired-post" else None,
        )
    unavailable["expired-user"].expires_at = past
    unavailable["disabled"].status = UserStatus.DISABLED.value
    unavailable["deleted"].is_deleted = True
    unavailable["deleted"].deleted_at = datetime.now(UTC)
    unavailable["unestablished"].invitation_sent_at = datetime.now(UTC)
    db.commit()
    client = board_client(db, viewer, router)
    endpoint = f"/api/boards/{board.id}/post-authors"
    ids = [author.id for author in [*requested, *unavailable.values(), requested[0]]]
    ids += [uuid7() for _ in range(100 - len(ids))]
    params = [("ids", str(value)) for value in ids]

    pages = [
        client.get(endpoint, params=[*params, ("limit", "1"), ("offset", str(offset))])
        for offset in (0, 1)
    ]

    assert all(response.status_code == 200 for response in pages)
    assert [response.json()["items"][0]["id"] for response in pages] == [
        str(author.id) for author in sorted(requested, key=lambda author: author.id)
    ]
    for offset, response in enumerate(pages):
        assert response.headers["cache-control"] == "private, no-store"
        assert response.json()["pagination"] == {
            "limit": 1,
            "offset": offset,
            "count": 1,
            "total": 2,
            "has_more": offset == 0,
        }
        assert response.json()["items"][0]["label"] == "Lookup same label"
    searched = client.get(endpoint, params=[*params, ("search", requested[1].username)]).json()
    assert searched["items"] == [{"id": str(requested[1].id), "label": "Lookup same label"}]
    assert searched["pagination"]["total"] == 1
    absent_search = client.get(endpoint, params=[*params, ("search", decoy.username)]).json()
    assert absent_search["items"] == []
    assert absent_search["pagination"]["total"] == 0
    descending = client.get(
        endpoint, params=[*params, ("sort_by", "username"), ("sort_order", "desc")]
    ).json()
    assert [row["id"] for row in descending["items"]] == [
        str(author.id)
        for author in sorted(
            requested, key=lambda author: (author.username, author.id), reverse=True
        )
    ]
    unknown = client.get(endpoint, params={"ids": str(uuid7())}).json()
    assert unknown["items"] == []
    assert unknown["pagination"]["total"] == 0
    assert unknown["pagination"]["has_more"] is False
    default = client.get(endpoint).json()
    assert {row["id"] for row in default["items"]} == {
        str(author.id) for author in [*requested, decoy]
    }
    assert default["pagination"]["total"] == 3
    unsupported = client.get(endpoint, params=[*params, ("deleted", "include")])
    assert unsupported.status_code == 422


@pytest.mark.parametrize("kind", ["over_limit", "malformed", "empty"])
def test_author_ids_reject_unbounded_or_invalid_lookup(
    integration_owner_db: Session, kind: str
) -> None:
    db = integration_owner_db
    owner = member(db, "authors-lookup-validation-owner")
    board = writable_board(db, owner)
    db.commit()
    values = (
        [str(owner.id)] * 101
        if kind == "over_limit"
        else ["invalid" if kind == "malformed" else ""]
    )

    response = board_client(db, owner, router).get(
        f"/api/boards/{board.id}/post-authors", params=[("ids", value) for value in values]
    )

    assert response.status_code == 422, response.text
