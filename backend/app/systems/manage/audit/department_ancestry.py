"""Resolve an audited row's department before a flush can remove its parents."""

from collections.abc import Iterable
from typing import Any, cast
from uuid import UUID

from sqlalchemy import inspect, select
from sqlalchemy.orm import InstanceState, Session
from sqlalchemy.orm.base import LoaderCallableStatus

from app.systems.access.policy.models import GroupAccess
from app.systems.boards.attachment_models import BoardAttachment, BoardPostRevisionAttachment
from app.systems.boards.event_models import BoardEvent
from app.systems.boards.models import Board, BoardGroup, BoardScope
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.record_link_models import BoardPostRevisionRecordLink, BoardRecordLink
from app.systems.boards.reminder_models import BoardEventReminder
from app.systems.comms.conversations.models import (
    CommsCategory,
    CommsConversation,
    CommsMember,
)
from app.systems.comms.messages.interaction_models import CommsMention, CommsReaction, CommsThread
from app.systems.comms.messages.link_models import CommsMessageAttachment, CommsMessageRecordLink
from app.systems.comms.messages.models import CommsMessage, CommsMessageRevision
from app.systems.comms.settings.models import CommsCapabilityGrant, CommsSettings
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
    BoardGroup,
    BoardAttachment,
    BoardRecordLink,
    BoardEventReminder,
)
_REVISION_CHILDREN = (BoardPostRevisionAttachment, BoardPostRevisionRecordLink)
_COMMS_SCOPED_CHILDREN = (CommsSettings, CommsCapabilityGrant)
_COMMS_CONVERSATION_CHILDREN = (CommsMember, CommsMessage, CommsThread)
_COMMS_MESSAGE_CHILDREN = (
    CommsMessageRevision,
    CommsMention,
    CommsReaction,
    CommsMessageAttachment,
    CommsMessageRecordLink,
)


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


def _comms_department(instance: CommsCategory | CommsConversation) -> DepartmentRef:
    state = cast(InstanceState[CommsCategory | CommsConversation], inspect(instance))
    assert state is not None
    attribute = state.attrs.department
    department = attribute.loaded_value
    # A changed relationship, including None, wins before FK synchronization.
    # An unchanged loaded parent must not mask an explicit FK edit.
    if (isinstance(department, Department) or department is None) and (
        attribute.history.has_changes()
        or (
            instance.department_id is None
            and not state.attrs.department_id.history.has_changes()
        )
    ):
        return department
    return instance.department_id


class DepartmentAncestry:
    """Prefer in-memory parents, then batch-read surviving parents before flush."""

    def __init__(self, session: Session, changes: Iterable[object]) -> None:
        instances = tuple(changes)
        known = tuple(session.identity_map.values()) + tuple(session.new) + tuple(session.deleted)
        self._load_comms(session, instances, known)
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

    def _load_comms(
        self, session: Session, instances: tuple[object, ...], known: tuple[object, ...]
    ) -> None:
        self.comms_messages = {
            item.id: item for item in known if isinstance(item, CommsMessage) and item.id
        }
        self.comms_conversations = {
            item.id: item for item in known if isinstance(item, CommsConversation) and item.id
        }
        self.comms_categories = {
            item.id: item for item in known if isinstance(item, CommsCategory) and item.id
        }
        message_ids = _ids(
            (item for item in instances if isinstance(item, _COMMS_MESSAGE_CHILDREN)), "message_id"
        )
        missing_messages = message_ids - self.comms_messages.keys()
        self.comms_message_conversations = (
            dict(session.execute(
                select(CommsMessage.id, CommsMessage.conversation_id).where(
                    CommsMessage.id.in_(missing_messages)
                )
            ).tuples().all()) if missing_messages else {}
        )
        # In-memory parents include relationship-assigned new/dirty parents whose
        # foreign key has not been synchronized yet. Never lazy-load one per child.
        conversation_ids = _ids(
            (item for item in (*instances, *known)
             if isinstance(item, (*_COMMS_CONVERSATION_CHILDREN, *_COMMS_SCOPED_CHILDREN))),
            "conversation_id",
        ) | set(self.comms_message_conversations.values())
        missing_conversations = conversation_ids - self.comms_conversations.keys()
        self.comms_conversation_departments = (
            {identity: (kind, scope, department_id)
             for identity, kind, scope, department_id in session.execute(
                 select(CommsConversation.id, CommsConversation.kind,
                        CommsConversation.scope, CommsConversation.department_id).where(
                     CommsConversation.id.in_(missing_conversations)
                 )
             ).tuples()} if missing_conversations else {}
        )
        category_ids = _ids(
            (item for item in instances if isinstance(item, _COMMS_SCOPED_CHILDREN)), "category_id"
        )
        missing_categories = category_ids - self.comms_categories.keys()
        self.comms_category_departments = (
            dict(session.execute(
                select(CommsCategory.id, CommsCategory.department_id).where(
                    CommsCategory.id.in_(missing_categories)
                )
            ).tuples().all()) if missing_categories else {}
        )

    def _comms_category(self, category: CommsCategory | UUID | None) -> DepartmentRef:
        if isinstance(category, UUID):
            cached = self.comms_categories.get(category)
            return (self._comms_category(cached) if cached is not None
                    else self.comms_category_departments.get(category))
        if category is None:
            return None
        return _comms_department(category)

    def _comms_conversation(
        self, conversation: CommsConversation | UUID | None
    ) -> DepartmentRef:
        if isinstance(conversation, UUID):
            cached = self.comms_conversations.get(conversation)
            if cached is not None:
                return self._comms_conversation(cached)
            kind, scope, department_id = self.comms_conversation_departments.get(
                conversation, (None, None, None)
            )
            return department_id if kind == "channel" and scope == "department" else None
        if (
            conversation is None
            or conversation.kind != "channel"
            or conversation.scope != "department"
        ):
            return None
        # Category placement is not channel access and cannot confer audit visibility.
        return _comms_department(conversation)

    def _comms_message(self, message: CommsMessage | UUID | None) -> DepartmentRef:
        if isinstance(message, UUID):
            cached = self.comms_messages.get(message)
            return (self._comms_message(cached) if cached is not None
                    else self._comms_conversation(self.comms_message_conversations.get(message)))
        if message is None:
            return None
        conversation = _parent(message, "conversation", message.conversation_id)
        return self._comms_conversation(
            conversation if isinstance(conversation, CommsConversation) else message.conversation_id
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
        if isinstance(instance, CommsCategory):
            return self._comms_category(instance)
        if isinstance(instance, CommsConversation):
            return self._comms_conversation(instance)
        if isinstance(instance, _COMMS_SCOPED_CHILDREN):
            category = _parent(instance, "category", instance.category_id)
            if category is not None:
                return self._comms_category(
                    category if isinstance(category, CommsCategory) else instance.category_id
                )
        if isinstance(instance, (*_COMMS_CONVERSATION_CHILDREN, *_COMMS_SCOPED_CHILDREN)):
            conversation = _parent(instance, "conversation", instance.conversation_id)
            return self._comms_conversation(
                conversation if isinstance(conversation, CommsConversation)
                else instance.conversation_id
            )
        if isinstance(instance, _COMMS_MESSAGE_CHILDREN):
            message = _parent(instance, "message", instance.message_id)
            return self._comms_message(
                message if isinstance(message, CommsMessage) else instance.message_id
            )
        return None
