"""Resolve an audited row's department before a flush can remove its parents."""

from collections.abc import Iterable
from typing import Any, cast
from uuid import UUID

from sqlalchemy import inspect, select
from sqlalchemy.orm import Session
from sqlalchemy.orm.base import LoaderCallableStatus

from app.systems.access.policy.models import GroupAccess
from app.systems.boards.attachment_models import BoardAttachment, BoardPostRevisionAttachment
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup, BoardScope, BoardWidget
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.record_link_models import BoardPostRevisionRecordLink, BoardRecordLink
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.openview.charts.models import Chart
from app.systems.openview.dashboards.models import Dashboard
from app.systems.openview.reports.models import Report
from app.systems.openview.views.models import SavedView
from app.systems.platform.files.models import File
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge

DepartmentRef = UUID | Department | None
BoardRef = UUID | Board | None

_MODULE_CHILDREN = (Field, Record, SavedView, Report, Chart)
_BOARD_CHILDREN = (
    BoardPost,
    BoardEvent,
    BoardWidget,
    BoardGroup,
    BoardAttachment,
    BoardRecordLink,
    BoardEventReminder,
)
_REVISION_CHILDREN = (BoardPostRevisionAttachment, BoardPostRevisionRecordLink)


def _ids(instances: Iterable[object], attribute: str) -> set[UUID]:
    return {
        value
        for instance in instances
        if isinstance(value := getattr(instance, attribute, None), UUID)
    }


def _parent(instance: object, relationship: str, foreign_id: UUID | None) -> object | None:
    state = inspect(instance)
    assert state is not None
    if relationship in state.mapper.relationships:
        attribute = state.attrs[relationship]
        value = attribute.loaded_value
        if (
            value is not LoaderCallableStatus.NO_VALUE
            and value is not None
            and (foreign_id is None or attribute.history.has_changes())
        ):
            return cast(object, value)
    return foreign_id


class DepartmentAncestry:
    """Prefer in-memory parents, then batch-read surviving parents before flush."""

    def __init__(self, session: Session, changes: Iterable[object]) -> None:
        instances = tuple(changes)
        known = tuple(session.identity_map.values()) + tuple(session.new) + tuple(session.deleted)
        self.modules = {item.id: item for item in known if isinstance(item, Module) and item.id}
        self.records = {item.id: item for item in known if isinstance(item, Record) and item.id}
        self.boards = {item.id: item for item in known if isinstance(item, Board) and item.id}
        self.posts = {item.id: item for item in known if isinstance(item, BoardPost) and item.id}
        self.revisions = {
            item.id: item for item in known if isinstance(item, BoardPostRevision) and item.id
        }

        revision_ids = _ids(
            (item for item in instances if isinstance(item, _REVISION_CHILDREN)), "revision_id"
        )
        self.revision_posts = (
            {
                revision_id: post_id
                for revision_id, post_id in session.execute(
                    select(BoardPostRevision.id, BoardPostRevision.post_id).where(
                        BoardPostRevision.id.in_(revision_ids - self.revisions.keys())
                    )
                ).tuples()
            }
            if revision_ids - self.revisions.keys()
            else {}
        )

        post_ids = (
            _ids((item for item in instances if isinstance(item, BoardPostRevision)), "post_id")
            | set(self.revision_posts.values())
            | {
                item.post_id
                for key, item in self.revisions.items()
                if key in revision_ids and isinstance(item.post_id, UUID)
            }
        )
        self.post_boards = (
            {
                post_id: board_id
                for post_id, board_id in session.execute(
                    select(BoardPost.id, BoardPost.board_id).where(
                        BoardPost.id.in_(post_ids - self.posts.keys())
                    )
                ).tuples()
            }
            if post_ids - self.posts.keys()
            else {}
        )

        board_ids = (
            _ids((item for item in instances if isinstance(item, _BOARD_CHILDREN)), "board_id")
            | set(self.post_boards.values())
            | {
                item.board_id
                for key, item in self.posts.items()
                if key in post_ids and isinstance(item.board_id, UUID)
            }
        )
        self.board_departments = (
            {
                board_id: (scope, department_id)
                for board_id, scope, department_id in session.execute(
                    select(Board.id, Board.scope, Board.department_id).where(
                        Board.id.in_(board_ids - self.boards.keys())
                    )
                ).tuples()
            }
            if board_ids - self.boards.keys()
            else {}
        )

        source_ids = _ids(
            (item for item in instances if isinstance(item, RelationshipEdge)),
            "source_record_id",
        )
        self.record_modules = (
            {
                record_id: module_id
                for record_id, module_id in session.execute(
                    select(Record.id, Record.module_id).where(
                        Record.id.in_(source_ids - self.records.keys())
                    )
                ).tuples()
            }
            if source_ids - self.records.keys()
            else {}
        )

        module_ids = (
            _ids((item for item in instances if isinstance(item, _MODULE_CHILDREN)), "module_id")
            | set(self.record_modules.values())
            | {
                item.module_id
                for key, item in self.records.items()
                if key in source_ids and isinstance(item.module_id, UUID)
            }
        )
        self.module_departments = (
            {
                module_id: department_id
                for module_id, department_id in session.execute(
                    select(Module.id, Module.department_id).where(
                        Module.id.in_(module_ids - self.modules.keys())
                    )
                ).tuples()
            }
            if module_ids - self.modules.keys()
            else {}
        )

    def _module(self, module: Module | UUID | None) -> DepartmentRef:
        if isinstance(module, UUID):
            cached = self.modules.get(module)
            if cached is not None:
                return self._module(cached)
            return self.module_departments.get(module)
        if module is None:
            return None
        department = _parent(module, "department", module.department_id)
        return department if isinstance(department, Department) else module.department_id

    def _record(self, record: Record | UUID | None) -> DepartmentRef:
        if isinstance(record, UUID):
            cached = self.records.get(record)
            if cached is not None:
                return self._record(cached)
            return self._module(self.record_modules.get(record))
        if record is None:
            return None
        module = _parent(record, "module", record.module_id)
        return self._module(module if isinstance(module, Module) else record.module_id)

    def _board(self, board: Board | UUID | None) -> DepartmentRef:
        if isinstance(board, UUID):
            cached = self.boards.get(board)
            if cached is not None:
                return self._board(cached)
            scope, department_id = self.board_departments.get(board, (None, None))
            return department_id if scope == BoardScope.DEPARTMENT else None
        if board is None:
            return None
        return board.department_id if board.scope == BoardScope.DEPARTMENT else None

    def _post(self, post: BoardPost | UUID | None) -> DepartmentRef:
        if isinstance(post, UUID):
            cached = self.posts.get(post)
            if cached is not None:
                return self._post(cached)
            return self._board(self.post_boards.get(post))
        return self._board(post.board_id) if post is not None else None

    def _revision(self, revision: BoardPostRevision | UUID | None) -> DepartmentRef:
        if isinstance(revision, UUID):
            cached = self.revisions.get(revision)
            if cached is not None:
                return self._revision(cached)
            return self._post(self.revision_posts.get(revision))
        return self._post(revision.post_id) if revision is not None else None

    def _board_ref(self, board_id: UUID | None) -> BoardRef:
        if board_id is None:
            return None
        cached = self.boards.get(board_id)
        if cached is not None:
            return cached
        return board_id if board_id in self.board_departments else None

    def _post_board_ref(self, post_id: UUID | None) -> BoardRef:
        if post_id is None:
            return None
        cached = self.posts.get(post_id)
        return self._board_ref(
            cached.board_id if cached is not None else self.post_boards.get(post_id)
        )

    def board_for_instance(self, instance: Any) -> BoardRef:
        """Capture a Board before flush, including new and soon-deleted parents."""

        if isinstance(instance, Board):
            return instance
        if isinstance(instance, _BOARD_CHILDREN):
            return self._board_ref(instance.board_id)
        if isinstance(instance, BoardPostRevision):
            return self._post_board_ref(instance.post_id)
        if isinstance(instance, _REVISION_CHILDREN):
            revision = self.revisions.get(instance.revision_id)
            return self._post_board_ref(
                revision.post_id
                if revision is not None
                else self.revision_posts.get(instance.revision_id)
            )
        return None

    def for_instance(self, instance: Any) -> DepartmentRef:
        if isinstance(instance, File):
            return instance.department_id if instance.purpose == "library_document" else None
        if isinstance(instance, Department):
            return instance
        if isinstance(instance, Module):
            return self._module(instance)
        if isinstance(instance, _MODULE_CHILDREN):
            module = _parent(instance, "module", instance.module_id)
            return self._module(module if isinstance(module, Module) else instance.module_id)
        if isinstance(instance, RelationshipEdge):
            record = _parent(instance, "source_record", instance.source_record_id)
            return self._record(record if isinstance(record, Record) else instance.source_record_id)
        if isinstance(instance, (Dashboard, GroupAccess)):
            return instance.department_id
        if isinstance(instance, Board):
            return self._board(instance)
        if isinstance(instance, _BOARD_CHILDREN):
            return self._board(instance.board_id)
        if isinstance(instance, BoardPostRevision):
            return self._post(instance.post_id)
        if isinstance(instance, _REVISION_CHILDREN):
            return self._revision(instance.revision_id)
        return None
