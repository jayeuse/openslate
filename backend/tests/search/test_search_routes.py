"""Search HTTP contracts and real PostgreSQL visibility, display and FTS behavior."""

from datetime import UTC, date, datetime, timedelta
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel, GroupMember
from app.systems.access.users.models import User, UserRole
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from tests.boards.support import department_board, grant, project_board
from tests.rbac.support import add_department, add_module, add_user, make_group_access, make_user
from tests.search.support import client as _client
from tests.search.support import ids as _ids
from tests.search.support import search as _search
from tests.search.support import titled_module as _module


def _post(
    db: Session,
    board: Board,
    author: User,
    title: str,
    *,
    body: str = "Published contents",
    status: str = "published",
    expired: bool = False,
    published: bool = True,
) -> BoardPost:
    item = BoardPost(
        board_id=board.id,
        author_id=author.id,
        title="Private working text",
        body="Unpublished secret",
        status=status,
        displayed_publication_number=1 if published else None,
    )
    db.add(item)
    db.flush()
    if published:
        now = datetime.now(UTC)
        db.add(
            BoardPostRevision(
                post_id=item.id,
                publication_number=1,
                publication_key=uuid7(),
                content_fingerprint="a" * 64,
                author_id=author.id,
                title=title,
                body=body,
                published_at=now - timedelta(days=2),
                expires_at=now - timedelta(days=1) if expired else None,
            )
        )
    db.flush()
    return item


def _event(db: Session, board: Board, author: User, title: str, **changes: object) -> BoardEvent:
    item = BoardEvent(
        board_id=board.id,
        author_id=author.id,
        title=title,
        all_day=True,
        start_date=date(2026, 9, 1),
        end_date=date(2026, 9, 1),
        timezone_name="UTC",
        **changes,
    )
    db.add(item)
    db.flush()
    return item


def test_empty_search_is_an_empty_standard_page_without_database_queries() -> None:
    database = Mock(spec=Session)
    api = _client(database, make_user("search-admin")[0])
    result = _search(api, "record", "   ", limit=10, offset=20)
    assert result == {
        "items": [],
        "pagination": {
            "limit": 10,
            "offset": 20,
            "count": 0,
            "total": 0,
            "has_more": False,
        },
    }
    database.execute.assert_not_called()
    database.scalar.assert_not_called()


def test_search_requires_identity_and_rejects_invalid_list_parameters() -> None:
    db = Mock(spec=Session)
    assert _client(db, None).get("/api/search?kind=record&search=test").status_code == 401
    api = _client(db, make_user("search-admin")[0])
    for params in (
        {},
        {"kind": "file"},
        {"kind": "record", "search": "x" * 101},
        {"kind": "record", "limit": 0},
        {"kind": "record", "limit": 101},
        {"kind": "record", "offset": -1},
        {"kind": "record", "sort_by": "title"},
        {"kind": "record", "sort_order": "random"},
        {"kind": "record", "deleted": "include"},
        {"kind": "record", "deleted": "only"},
    ):
        response = api.get("/api/search", params=params)
        assert response.status_code == 422, response.text


@pytest.mark.integration
def test_record_fts_filters_access_before_counts_and_searches_displayed_titles(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    admin, member, guest, outsider = (
        add_user(db, role=role)
        for role in (UserRole.ADMIN, UserRole.MEMBER, UserRole.GUEST, UserRole.MEMBER)
    )
    module, _, rows = _module(
        db, ["Scarlet service pump", "Scarlet service pump", "Scarlet servicing"]
    )
    department = module.department
    make_group_access(db, [member, guest], department, module)
    _, _, hidden_rows = _module(db, ["Scarlet service pump"])
    select_module, select_field, select_rows = _module(db, [str(uuid7())], kind="select")
    select_field.config = {
        "options": [
            {"id": select_rows[0].data[str(select_field.id)], "label": "Scarlet service pump"}
        ]
    }
    make_group_access(db, [member, guest], select_module.department, select_module)
    db.commit()
    for actor in (member, guest):
        result = _search(_client(db, actor), "record", " pump scarlet ", limit=1)
        assert result["pagination"] == {
            "limit": 1,
            "offset": 0,
            "count": 1,
            "total": 3,
            "has_more": True,
        }
        first = result["items"][0]
        assert set(first) == {
            "kind",
            "id",
            "title",
            "context_label",
            "module_id",
            "board_id",
            "can_open",
        }
        assert first["kind"] == "record" and first["title"] == "Scarlet service pump"
        assert first["board_id"] is None and first["can_open"] is True
        pages = [
            _search(_client(db, actor), "record", "pump scarlet", limit=1, offset=i)
            for i in range(3)
        ]
        expected = sorted([str(rows[0].id), str(rows[1].id), str(select_rows[0].id)], reverse=True)
        assert [page["items"][0]["id"] for page in pages] == expected
        assert pages[-1]["pagination"]["has_more"] is False
        assert _ids(_search(_client(db, actor), "record", "servic")) == set()
        assert _ids(_search(_client(db, actor), "record", "servicing")) == {str(rows[2].id)}
        assert (
            _ids(_search(_client(db, actor), "record", select_rows[0].data[str(select_field.id)]))
            == set()
        )
        assert _ids(_search(_client(db, actor), "record", "'; DROP TABLE records; --")) == set()
    assert _search(_client(db, outsider), "record", "scarlet")["pagination"]["total"] == 0
    assert str(hidden_rows[0].id) in _ids(_search(_client(db, admin), "record", "scarlet"))


@pytest.mark.integration
def test_record_fallback_titles_and_closed_roots(integration_owner_db: Session) -> None:
    db = integration_owner_db
    admin = add_user(db, role=UserRole.ADMIN)
    _, field, rows = _module(db, [None, "  ", "Unavailable"])
    missing, _, missing_rows = _module(db, ["Hidden configured value"])
    missing.title_field_id = None
    _, select_field, select_rows = _module(db, [str(uuid7())], kind="select")
    select_field.config = {"options": []}
    _, deleted_field, field_rows = _module(db, ["Hidden closed field"])
    deleted_field.is_deleted = True
    _, _, type_rows = _module(db, [True], kind="boolean")
    other_field_module, _, other_rows = _module(db, ["Wrong module title"])
    other_field_module.title_field_id = field.id
    deleted_module, _, _ = _module(db, ["Scarlet root"])
    deleted_module.is_deleted = True
    deleted_department, _, _ = _module(db, ["Scarlet root"])
    deleted_department.department.is_deleted = True
    rows[2].is_deleted = True
    db.commit()
    api = _client(db, admin)
    fallback_rows = [*rows[:2], *missing_rows, *select_rows, *field_rows, *type_rows, *other_rows]
    result = _search(api, "record", "record")
    assert _ids(result) == {str(row.id) for row in fallback_rows}
    assert {item["id"]: item["title"] for item in result["items"]} == {
        str(row.id): f"Record {str(row.id)[:8]}" for row in fallback_rows
    }
    assert _ids(_search(api, "record", "scarlet root")) == set()
    assert _ids(_search(api, "record", "Unavailable")) == set()


@pytest.mark.integration
def test_people_are_active_established_readers_of_readable_live_modules_only(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    admin, actor, visitor, peer, outsider = (
        add_user(db, role=role)
        for role in (
            UserRole.ADMIN,
            UserRole.MEMBER,
            UserRole.GUEST,
            UserRole.MEMBER,
            UserRole.MEMBER,
        )
    )
    module = add_module(db, add_department(db))
    make_group_access(db, [actor, visitor], module.department, module)
    make_group_access(db, [peer], module.department)
    hidden = add_module(db, add_department(db))
    make_group_access(db, [outsider], hidden.department, hidden)
    for user in (admin, actor, visitor, peer, outsider):
        user.display_name = "Indigo person"
    inactive = add_user(db, status="disabled")
    inactive.display_name = "Indigo person"
    unaccepted = add_user(db)
    unaccepted.invitation_sent_at = datetime.now(UTC)
    unaccepted.display_name = "Indigo person"
    expired = add_user(db, role=UserRole.GUEST, expires_at=datetime.now(UTC) - timedelta(days=1))
    expired.display_name = "Indigo person"
    deleted = add_user(db)
    deleted.is_deleted = True
    deleted.display_name = "Indigo person"
    pending = add_user(db, status="pending")
    pending.display_name = "Indigo person"
    make_group_access(db, [inactive, unaccepted, expired, deleted], module.department, module)
    db.commit()
    for user in (actor, visitor):
        result = _search(_client(db, user), "person", "indigo")
        assert _ids(result) == {str(item.id) for item in (admin, actor, visitor, peer)}
        assert result["pagination"]["total"] == 4
        for item in result["items"]:
            assert (
                item["can_open"] is False and item["module_id"] is None and item["board_id"] is None
            )
            assert "email" not in item and item["context_label"]
    admin_result = _search(_client(db, admin), "person", "indigo")
    assert _ids(admin_result) == {str(item.id) for item in (admin, actor, visitor, peer, outsider)}
    assert all(item["can_open"] for item in admin_result["items"])
    assert _ids(_search(_client(db, actor), "person", outsider.email)) == set()
    assert _ids(_search(_client(db, actor), "person", peer.username)) == {str(peer.id)}
    dead_reader = add_user(db)
    dead_reader.display_name = "Indigo person"
    dead_access = make_group_access(db, [dead_reader], module.department, module)
    dead_access.is_deleted = True
    db.commit()
    assert str(dead_reader.id) not in _ids(_search(_client(db, actor), "person", "indigo"))
    module.is_deleted = True
    db.commit()
    assert _search(_client(db, actor), "person", "indigo")["pagination"]["total"] == 0


@pytest.mark.integration
def test_posts_search_displayed_publication_and_per_board_expiry_authority(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    admin, author, manager, reader, visitor, outsider = (
        add_user(db, role=role)
        for role in (
            UserRole.ADMIN,
            UserRole.MEMBER,
            UserRole.MEMBER,
            UserRole.MEMBER,
            UserRole.GUEST,
            UserRole.MEMBER,
        )
    )
    managed, read_only, hidden, archived = [project_board(db) for _ in range(4)]
    for board in (managed, read_only, archived):
        grant(db, board, [author], AccessLevel.WRITE)
        grant(db, board, [reader], AccessLevel.READ)
        grant(db, board, [visitor], AccessLevel.MANAGE)
    grant(db, managed, [manager], AccessLevel.MANAGE)
    grant(db, read_only, [manager], AccessLevel.READ)
    live = _post(db, managed, author, "Copper notice", status="draft", body="Visible bodyword")
    expired = _post(db, managed, author, "Copper expired", expired=True)
    other_expired = _post(db, read_only, author, "Copper other expired", expired=True)
    _post(db, hidden, author, "Copper hidden")
    _post(db, archived, author, "Copper Board archived")
    archived.status = "archived"
    _post(db, managed, author, "Copper post archived", status="archived")
    _post(db, managed, author, "Copper unpublished", status="draft", published=False)
    deleted = _post(db, managed, author, "Copper deleted")
    deleted.is_deleted = True
    db.commit()
    for user in (reader, visitor):
        result = _search(_client(db, user), "post", "copper")
        assert _ids(result) == {str(live.id)}
        assert result["items"][0]["title"] == "Copper notice"
        assert result["items"][0]["context_label"] == managed.name
        assert result["items"][0]["board_id"] == str(managed.id)
        assert result["items"][0]["module_id"] is None and result["items"][0]["can_open"] is True
        assert _ids(_search(_client(db, user), "post", "bodyword")) == {str(live.id)}
        assert _ids(_search(_client(db, user), "post", "unpublished secret")) == set()
    assert _ids(_search(_client(db, manager), "post", "copper")) == {str(live.id), str(expired.id)}
    assert _ids(_search(_client(db, author), "post", "copper")) == {
        str(item.id) for item in (live, expired, other_expired)
    }
    assert _search(_client(db, outsider), "post", "copper")["pagination"]["total"] == 0
    assert str(other_expired.id) in _ids(_search(_client(db, admin), "post", "copper"))

    department = add_department(db)
    module = add_module(db, department)
    scoped_board = department_board(db, department)
    module_manager = add_user(db)
    department_manager = add_user(db)
    revoked = add_user(db)
    make_group_access(db, [module_manager], department, module, level=AccessLevel.MANAGE)
    make_group_access(db, [department_manager], department, level=AccessLevel.MANAGE)
    make_group_access(db, [visitor], department, level=AccessLevel.MANAGE)
    removed = make_group_access(db, [revoked], department, level=AccessLevel.MANAGE)
    membership = db.query(GroupMember).filter_by(group_id=removed.group_id).one()
    membership.is_deleted = True
    scoped_expired = _post(db, scoped_board, author, "Quartz expired", expired=True)
    db.commit()
    assert _ids(_search(_client(db, department_manager), "post", "quartz")) == {
        str(scoped_expired.id)
    }
    for user in (module_manager, visitor, revoked):
        assert _search(_client(db, user), "post", "quartz")["pagination"]["total"] == 0


@pytest.mark.integration
def test_events_search_each_visible_live_series_title_details_and_location(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author, reader, visitor, outsider = (
        add_user(db, role=role)
        for role in (UserRole.MEMBER, UserRole.MEMBER, UserRole.GUEST, UserRole.MEMBER)
    )
    board, hidden, archived = [project_board(db) for _ in range(3)]
    for target in (board, archived):
        grant(db, target, [reader, visitor])
    title = _event(db, board, author, "Violet planning")
    details = _event(db, board, author, "Planning", details="Violet agenda")
    location = _event(
        db,
        board,
        author,
        "Planning",
        location="Violet room",
        recurrence="weekly",
        repeat_until=date(2026, 12, 1),
    )
    _event(db, hidden, author, "Violet hidden")
    _event(db, archived, author, "Violet Board archived")
    archived.status = "archived"
    _event(db, board, author, "Violet archived", archived=True)
    deleted = _event(db, board, author, "Violet deleted")
    deleted.is_deleted = True
    db.commit()
    for user in (reader, visitor):
        result = _search(_client(db, user), "event", "violet")
        assert _ids(result) == {str(item.id) for item in (title, details, location)}
        assert result["pagination"]["total"] == 3
        assert all(
            item["board_id"] == str(board.id) and item["context_label"] == board.name
            for item in result["items"]
        )
    assert _search(_client(db, outsider), "event", "violet")["pagination"]["total"] == 0


@pytest.mark.integration
def test_relevance_precedes_uuid_and_ascending_reverses_rank(integration_owner_db: Session) -> None:
    db = integration_owner_db
    admin = add_user(db, role=UserRole.ADMIN)
    _, _, rows = _module(db, ["Amber " * 8, "Amber"])
    db.commit()
    api = _client(db, admin)
    descending = _search(api, "record", "amber", limit=1)
    ascending = _search(api, "record", "amber", limit=1, sort_order="asc")
    assert descending["items"][0]["id"] == str(rows[0].id)
    assert ascending["items"][0]["id"] == str(rows[1].id)
    assert descending["pagination"]["total"] == ascending["pagination"]["total"] == 2
    assert UUID(rows[0].id.hex).int < UUID(rows[1].id.hex).int


@pytest.mark.integration
@pytest.mark.parametrize(
    ("kind", "value", "display"),
    [
        ("long_text", "Emerald description", "Emerald description"),
        ("email", "emerald@example.test", "emerald@example.test"),
        ("url", "https://emerald.example.test", "https://emerald.example.test"),
        ("int", 4317, "4317"),
        ("number", 4317.25, "4317.25"),
        ("decimal", "4317.2500", "4317.2500"),
    ],
)
def test_supported_scalar_record_title_types_keep_displayed_text(
    integration_owner_db: Session,
    kind: str,
    value: object,
    display: str,
) -> None:
    db = integration_owner_db
    actor = add_user(db, role=UserRole.ADMIN)
    module, _, rows = _module(db, [value], kind=kind)
    db.commit()
    result = _search(_client(db, actor), "record", display)
    assert _ids(result) == {str(rows[0].id)}
    assert result["items"][0]["title"] == display
    assert result["items"][0]["module_id"] == str(module.id)
