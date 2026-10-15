"""Board schema guarantees on the runner-owned disposable PostgreSQL database.

Each database function that was renamed or replaced when announcements became
posts must still reject the same invalid rows, and no catalog object may keep an
old table or column name.
"""

from datetime import UTC, datetime
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.users.models import User
from app.systems.boards.attachment_models import BoardAttachment, BoardPostRevisionAttachment
from app.systems.boards.models import Board, BoardGroup, BoardScope
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.record_link_models import BoardPostRevisionRecordLink, BoardRecordLink
from app.systems.platform.files.models import File
from app.systems.sandbox.records.models import Record
from tests.boards.support import department_board, member, project_board
from tests.rbac.support import add_department, add_module

pytestmark = pytest.mark.integration

OLD_NAMES = (
    "board_announcement",
    "board_content_",
    "announcement_id",
    "board_grants",
    "board_favorites",
    "board_homes",
    "board_templates",
    "board_record_placements",
    "personal_states",
)
REPLACED_FUNCTIONS = (
    "reject_board_post_revision_update",
    "validate_board_attachment",
    "reject_board_attachment_owner_change",
    "validate_revision_attachment",
    "reject_revision_attachment_update",
    "board_record_link_guard",
    "board_revision_record_link_guard",
    "reject_file_board_move",
)


def _rejects(db: Session, change: object) -> None:
    savepoint = db.begin_nested()
    if callable(change):
        change()
    else:
        db.add(change)
    with pytest.raises(IntegrityError):
        db.flush()
    savepoint.rollback()


def _file(db: Session, board: Board, creator: User) -> File:
    file = File(
        purpose="board_attachment",
        board_id=board.id,
        record_id=None,
        creator_id=creator.id,
        filename="notes.pdf",
        expected_size=3,
        object_key=uuid4().hex,
        state="awaiting_upload",
    )
    db.add(file)
    db.flush()
    return file


def _post(db: Session, board: Board, author: User) -> BoardPost:
    item = BoardPost(board_id=board.id, author_id=author.id, title="Title", body="Body")
    db.add(item)
    db.flush()
    return item


def _revision(db: Session, item: BoardPost, number: int = 1) -> BoardPostRevision:
    revision = BoardPostRevision(
        post_id=item.id,
        publication_number=number,
        publication_key=uuid7(),
        content_fingerprint="a" * 64,
        author_id=item.author_id,
        title=item.title,
        body=item.body,
        published_at=datetime.now(UTC),
    )
    db.add(revision)
    db.flush()
    return revision


def test_no_catalog_object_keeps_an_old_board_name(integration_owner_db: Session) -> None:
    pattern = "(" + "|".join(OLD_NAMES) + ")"
    found = integration_owner_db.connection().execute(
        text(
            """
            SELECT 'function ' || p.proname FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND (p.prosrc ~ :pattern OR p.proname ~ :pattern)
            UNION ALL
            SELECT 'trigger ' || t.tgname FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND NOT t.tgisinternal
               AND (t.tgname ~ :pattern OR pg_get_triggerdef(t.oid) ~ :pattern)
            UNION ALL
            SELECT 'constraint ' || con.conname FROM pg_constraint con
              JOIN pg_namespace n ON n.oid = con.connamespace
             WHERE n.nspname = 'public'
               AND (con.conname ~ :pattern OR pg_get_constraintdef(con.oid) ~ :pattern)
            UNION ALL
            SELECT 'index ' || indexname FROM pg_indexes
             WHERE schemaname = 'public' AND (indexname ~ :pattern OR indexdef ~ :pattern)
            UNION ALL
            SELECT 'relation ' || c.relname FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname ~ :pattern
            UNION ALL
            SELECT 'column ' || table_name || '.' || column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND column_name ~ :pattern
            """
        ),
        {"pattern": pattern},
    ).scalars().all()
    assert list(found) == []


def test_the_runtime_role_can_execute_every_replaced_function(
    integration_owner_db: Session,
) -> None:
    rows = integration_owner_db.connection().execute(
        text(
            """
            SELECT p.proname, has_function_privilege('openslate_app', p.oid, 'EXECUTE')
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = ANY(:names)
            """
        ),
        {"names": list(REPLACED_FUNCTIONS)},
    ).tuples().all()
    assert dict(rows) == dict.fromkeys(REPLACED_FUNCTIONS, True)


def test_board_scope_constraints(integration_owner_db: Session) -> None:
    db = integration_owner_db
    department = add_department(db)
    department_board(db, department)

    _rejects(db, Board(scope="team", name="Unknown scope"))
    _rejects(db, Board(scope=BoardScope.COMPANY.value, name="Second company"))
    _rejects(db, Board(scope=BoardScope.DEPARTMENT.value, name="No department"))
    _rejects(
        db,
        Board(scope=BoardScope.PROJECT.value, department_id=department.id, name="Project"),
    )
    _rejects(
        db,
        Board(scope=BoardScope.DEPARTMENT.value, department_id=department.id, name="Second"),
    )


def test_board_groups_allow_one_active_row_for_each_group_and_a_known_level(
    integration_owner_db: Session,
) -> None:
    from app.systems.access.policy.models import Group

    db = integration_owner_db
    board = project_board(db)
    group = Group(name=f"Group {uuid7().hex}")
    db.add(group)
    db.flush()
    first = BoardGroup(board_id=board.id, group_id=group.id, level="write")
    db.add(first)
    db.flush()

    _rejects(db, BoardGroup(board_id=board.id, group_id=group.id, level="read"))
    _rejects(db, BoardGroup(board_id=board.id, group_id=uuid7(), level="owner"))
    first.is_deleted = True
    db.flush()
    db.add(BoardGroup(board_id=board.id, group_id=group.id, level="manage"))
    db.flush()


def test_published_post_revisions_and_revision_attachments_are_immutable(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    item = _post(db, board, author)
    file = _file(db, board, author)
    db.add(BoardAttachment(board_id=board.id, file_id=file.id, post_id=item.id))
    db.flush()
    revision = _revision(db, item)
    snapshot = BoardPostRevisionAttachment(revision_id=revision.id, file_id=file.id)
    db.add(snapshot)
    db.flush()

    def change_revision() -> None:
        revision.title = "Rewritten history"

    def change_snapshot() -> None:
        snapshot.file_id = _file(db, board, author).id

    _rejects(db, change_revision)
    _rejects(db, change_snapshot)


def test_attachments_must_match_the_board_of_their_file_and_their_post(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    board, other = project_board(db), project_board(db)
    item, other_item = _post(db, board, author), _post(db, other, author)
    file, other_file = _file(db, board, author), _file(db, other, author)

    _rejects(db, BoardAttachment(board_id=board.id, file_id=other_file.id, post_id=item.id))
    _rejects(db, BoardAttachment(board_id=board.id, file_id=file.id, post_id=other_item.id))
    owner = BoardAttachment(board_id=board.id, file_id=file.id, post_id=item.id)
    db.add(owner)
    db.flush()
    second = _post(db, board, author)

    def move_owner() -> None:
        owner.post_id = second.id

    _rejects(db, move_owner)
    owner.is_linked = False
    db.flush()


def test_a_revision_attachment_needs_the_file_of_its_post(integration_owner_db: Session) -> None:
    db = integration_owner_db
    author = member(db)
    board = project_board(db)
    item, other_item = _post(db, board, author), _post(db, board, author)
    file = _file(db, board, author)
    db.add(BoardAttachment(board_id=board.id, file_id=file.id, post_id=other_item.id))
    db.flush()
    revision = _revision(db, item)

    _rejects(db, BoardPostRevisionAttachment(revision_id=revision.id, file_id=file.id))


def test_record_links_must_match_their_board_post_and_record(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    author = member(db)
    department = add_department(db)
    module, other_module = add_module(db, department), add_module(db, department)
    record = Record(module_id=module.id, data={})
    db.add(record)
    db.flush()
    board, other = project_board(db), project_board(db)
    item, other_item = _post(db, board, author), _post(db, other, author)

    _rejects(
        db,
        BoardRecordLink(
            board_id=board.id,
            post_id=other_item.id,
            record_id=record.id,
            module_id=module.id,
        ),
    )
    _rejects(
        db,
        BoardRecordLink(
            board_id=board.id,
            post_id=item.id,
            record_id=record.id,
            module_id=other_module.id,
        ),
    )
    link = BoardRecordLink(
        board_id=board.id, post_id=item.id, record_id=record.id, module_id=module.id
    )
    db.add(link)
    db.flush()

    def move_link() -> None:
        link.post_id = _post(db, board, author).id

    _rejects(db, move_link)
    revision = _revision(db, item)
    _rejects(
        db,
        BoardPostRevisionRecordLink(
            revision_id=revision.id, record_id=record.id, module_id=other_module.id
        ),
    )
    snapshot = BoardPostRevisionRecordLink(
        revision_id=revision.id, record_id=record.id, module_id=module.id
    )
    db.add(snapshot)
    db.flush()

    def change_snapshot() -> None:
        snapshot.is_deleted = True

    _rejects(db, change_snapshot)
    unrelated = _revision(db, other_item)
    _rejects(
        db,
        BoardPostRevisionRecordLink(
            revision_id=unrelated.id, record_id=record.id, module_id=module.id
        ),
    )


def test_a_board_file_cannot_move_to_another_board(integration_owner_db: Session) -> None:
    db = integration_owner_db
    author = member(db)
    board, other = project_board(db), project_board(db)
    file = _file(db, board, author)

    def move_file() -> None:
        file.board_id = other.id

    _rejects(db, move_file)
