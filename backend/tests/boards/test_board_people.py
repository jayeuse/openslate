"""The people who can read a Board, for the card assignee picker of its writers."""

from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.boards.access_preview_router import router as people_router
from app.systems.boards.card_router import router as card_router
from app.systems.boards.models import Board
from tests.boards.kanban_support import add_stage
from tests.boards.support import client, department_board, grant, project_board
from tests.conftest import membership_of
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration


def _person(db: Session, name: str, role: str = UserRole.MEMBER,
            status: str = UserStatus.ACTIVE) -> User:
    """A person whose email starts with the first word of ``name``, lowercased."""

    user = add_user(db, name.split()[0].lower(), role=role, status=status)
    user.display_name = name
    db.flush()
    return user


def _api(db: Session, actor: User) -> TestClient:
    return client(db, actor, people_router, card_router)


def _people(api: TestClient, board: Board, **params: object) -> dict:
    response = api.get(f"/api/boards/{board.id}/people", params=params)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "private, no-store"
    return response.json()


def _names(page: dict) -> list[str]:
    return [item["display_name"] for item in page["items"]]


def _avatar(db: Session, user: User) -> None:
    file_id = uuid7()
    db.connection().execute(
        text(
            "INSERT INTO files(id,purpose,creator_id,filename,expected_size,object_key,state) "
            "VALUES(:id,'user_avatar',:owner,'avatar.png',100,:key,'awaiting_upload')"
        ),
        {"id": file_id, "owner": user.id, "key": uuid7().hex},
    )
    user.avatar_file_id = file_id
    db.flush()


def test_writers_and_managers_list_every_active_reader_and_others_are_refused(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board = project_board(db)
    writer, manager = _person(db, "Ana Writer"), _person(db, "bea Manager")
    reader, outsider = _person(db, "Cy Reader"), _person(db, "Zed Outsider")
    guest_reader = _person(db, "Dee Guest", UserRole.GUEST)
    guest_writer = _person(db, "Eve Guest", UserRole.GUEST)
    admin = _person(db, "Fay Admin", UserRole.ADMIN)
    disabled = _person(db, "Gil Disabled", status=UserStatus.DISABLED)
    removed = _person(db, "Hal Removed")
    grant(db, board, [writer], AccessLevel.WRITE)
    grant(db, board, [manager], AccessLevel.MANAGE)
    grant(db, board, [reader, guest_reader, disabled, removed], AccessLevel.READ)
    grant(db, board, [guest_writer], AccessLevel.WRITE)
    membership_of(db, removed.id).is_deleted = True
    _avatar(db, reader)
    db.commit()

    expected = ["Ana Writer", "bea Manager", "Cy Reader", "Dee Guest", "Eve Guest", "Fay Admin"]
    for caller in (writer, manager, admin):
        assert _names(_people(_api(db, caller), board)) == expected
    page = _people(_api(db, writer), board)
    assert all(set(item) == {"id", "display_name", "avatar_url"} for item in page["items"])
    avatars = {item["id"]: item["avatar_url"] for item in page["items"]}
    assert avatars[str(reader.id)] == f"/api/users/{reader.id}/avatar"
    assert avatars[str(writer.id)] is None
    assert page["pagination"] == {"limit": 25, "offset": 0, "count": 6, "total": 6,
                                  "has_more": False}
    for denied in (reader, guest_reader, guest_writer):
        assert _api(db, denied).get(f"/api/boards/{board.id}/people").status_code == 403
    assert _api(db, outsider).get(f"/api/boards/{board.id}/people").status_code == 404
    assert _api(db, writer).get(f"/api/boards/{uuid7()}/people").status_code == 404


def test_a_department_board_lists_department_and_module_readers_only(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    department, elsewhere = add_department(db), add_department(db)
    board = department_board(db, department)
    module, other_module = add_module(db, department), add_module(db, elsewhere)
    writer, reader = _person(db, "Ana Writer"), _person(db, "Bo Reader")
    module_reader = _person(db, "Cy Module")
    other_department = _person(db, "Dee Elsewhere")
    _person(db, "Eve Nobody")
    make_group_access(db, [writer], department, level=AccessLevel.WRITE)
    make_group_access(db, [reader], department)
    make_group_access(db, [module_reader], department, module)
    make_group_access(db, [other_department], elsewhere, other_module, level=AccessLevel.MANAGE)
    db.commit()

    assert _names(_people(_api(db, writer), board)) == ["Ana Writer", "Bo Reader", "Cy Module"]


@pytest.mark.parametrize("scope", ["project", "department"])
def test_every_listed_person_is_an_accepted_assignee_and_no_one_else_is(
    integration_owner_db: Session, scope: str
) -> None:
    db = integration_owner_db
    writer, reader = _person(db, "Ana Writer"), _person(db, "Bo Reader")
    guest_reader, admin = _person(db, "Cy Guest", UserRole.GUEST), _person(db, "Di Admin",
                                                                           UserRole.ADMIN)
    outsider = _person(db, "Ed Outsider")
    disabled = _person(db, "Flo Disabled", status=UserStatus.DISABLED)
    removed = _person(db, "Gus Removed")
    if scope == "project":
        board = project_board(db)
        grant(db, board, [writer], AccessLevel.WRITE)
        grant(db, board, [reader, guest_reader, disabled, removed], AccessLevel.READ)
    else:
        department = add_department(db)
        board = department_board(db, department)
        make_group_access(db, [writer], department, level=AccessLevel.WRITE)
        make_group_access(db, [reader, disabled, removed], department)
        make_group_access(db, [guest_reader], department, add_module(db, department))
    membership_of(db, removed.id).is_deleted = True
    stage = add_stage(db, board)
    db.commit()

    api = _api(db, writer)
    listed = [UUID(item["id"]) for item in _people(api, board)["items"]]
    assert set(listed) == {writer.id, reader.id, guest_reader.id, admin.id}
    cards = f"/api/boards/{board.id}/cards"
    for person in (*listed, outsider.id, disabled.id, removed.id):
        response = api.post(cards, json={"kind": "objective", "stage_id": str(stage.id),
                                         "title": "Check", "assignee_id": str(person)})
        if person in listed:
            assert response.status_code == 201, response.text
        else:
            assert response.status_code == 409, response.text
            assert response.json()["detail"]["code"] == "assignee_unavailable"


def test_search_matches_the_name_or_email_and_pages_follow_the_name_order(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    board = project_board(db)
    writer = _person(db, "Ana Writer")
    readers = [_person(db, name) for name in ("Bo Lee", "cy Leeds", "Di Mora", "Ed Rivers")]
    grant(db, board, [writer], AccessLevel.WRITE)
    grant(db, board, readers, AccessLevel.READ)
    db.commit()
    api = _api(db, writer)

    assert _names(_people(api, board, search="LEE")) == ["Bo Lee", "cy Leeds"]
    # Usernames are not on the person card, so they are not searched.
    assert _names(_people(api, board, search=readers[0].username)) == []
    assert _names(_people(api, board, search="ed-")) == ["Ed Rivers"]
    assert _names(_people(api, board, search="example.com")) == [
        "Ana Writer", "Bo Lee", "cy Leeds", "Di Mora", "Ed Rivers"]
    first = _people(api, board, limit=2)
    second = _people(api, board, limit=2, offset=2)
    last = _people(api, board, limit=2, offset=4)
    assert (_names(first), _names(second), _names(last)) == (
        ["Ana Writer", "Bo Lee"], ["cy Leeds", "Di Mora"], ["Ed Rivers"])
    assert first["pagination"] == {"limit": 2, "offset": 0, "count": 2, "total": 5,
                                   "has_more": True}
    assert last["pagination"]["has_more"] is False


@contextmanager
def _statements(db: Session) -> Iterator[list[str]]:
    executed: list[str] = []
    connection = db.connection()

    def record(_connection: object, _cursor: object, statement: str, *_args: object) -> None:
        # Binding the transaction to its organization is infrastructure, not route work.
        if "set_config('openslate.org_id'" not in statement:
            executed.append(" ".join(statement.split())[:160])

    event.listen(connection, "before_cursor_execute", record)
    try:
        yield executed
    finally:
        event.remove(connection, "before_cursor_execute", record)


def test_the_read_costs_the_same_statements_for_two_or_twenty_five_readers(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    writer = _person(db, "Ana Writer")
    small, large = project_board(db), project_board(db)
    grant(db, small, [writer], AccessLevel.WRITE)
    grant(db, large, [writer], AccessLevel.WRITE)
    grant(db, small, [_person(db, "Bo Reader")], AccessLevel.READ)
    grant(db, large, [_person(db, f"Reader {number:02d}") for number in range(24)],
          AccessLevel.READ)
    db.commit()
    api = _api(db, writer)
    _people(api, small)
    # Load the expired Boards here, so the windows below hold the route's statements only.
    db.refresh(large)
    with _statements(db) as few:
        assert _people(api, small, limit=100)["pagination"]["total"] == 2
    with _statements(db) as many:
        assert _people(api, large, limit=100)["pagination"]["total"] == 25
    assert len(few) == len(many), (few, many)
