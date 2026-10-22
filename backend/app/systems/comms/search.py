"""Comms-only indexed search with current source admission and plain code-point highlights."""

import re
from datetime import UTC, date, datetime, time, timedelta
from enum import StrEnum
from typing import Annotated, Literal, Self
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field, field_validator, model_validator
from sqlalchemy import Select, case, exists, false, func, literal, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.common.listing import (
    ListQuerySpec,
    SortOrder,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import get_db
from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.comms.access import error, readable_conversation_ids
from app.systems.comms.conversations.models import CommsConversation
from app.systems.comms.messages.interaction_models import CommsThread
from app.systems.comms.messages.link_models import CommsMessageAttachment, CommsMessageRecordLink
from app.systems.comms.messages.models import CommsMessage
from app.systems.comms.messages.schemas import Sequence as MessageSequence
from app.systems.comms.messages.schemas import Watermark, WireModel
from app.systems.platform.files.models import File
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record


class CommsSearchSort(StrEnum):
    CREATED = "created_at"
    RELEVANCE = "relevance"


class CommsSearchRequest(WireModel):
    q: str = Field("", max_length=4000)
    limit: int = Field(25, ge=1, le=100)
    offset: Watermark = 0
    sort_by: CommsSearchSort = CommsSearchSort.RELEVANCE
    sort_order: SortOrder = SortOrder.ASC
    sender_id: UUID | None = Field(None, alias="from")
    conversation_id: UUID | None = Field(None, alias="in")
    before: date | None = None
    after: date | None = None
    on: date | None = None
    has: Literal["file", "link", "record"] | None = None
    state: Literal["pinned", "thread"] | None = Field(None, alias="is")

    @field_validator("q", mode="before")
    @classmethod
    def query_text(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        value = value.strip()
        if "\x00" in value:
            raise ValueError("Search text cannot contain NUL")
        try:
            value.encode("utf-8")
        except UnicodeError as exc:
            raise ValueError("Search text must be valid Unicode") from exc
        return value

    @field_validator("before", "after", "on", mode="before")
    @classmethod
    def calendar_date(cls, value: object) -> object:
        if isinstance(value, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value) is None:
            raise ValueError("Use an ISO calendar date")
        return value

    @model_validator(mode="after")
    def ordered_dates(self) -> Self:
        if self.after is not None and self.before is not None and self.after >= self.before:
            raise ValueError("after must precede before")
        return self


class MatchOffset(WireModel):
    start: Watermark
    end: Watermark


class SearchHit(WireModel):
    message_id: UUID
    conversation_id: UUID
    conversation_name: str
    seq: MessageSequence
    author_id: UUID
    author_name: str
    created_at: datetime
    excerpt: str
    matches: list[MatchOffset]
    parent_id: UUID | None


def _midnight(day: date) -> datetime:
    return datetime.combine(day, time.min, UTC)


def _candidates(
    db: Session, actor: User, request: CommsSearchRequest, readable: set[UUID]
) -> Select[tuple[UUID]]:
    m, org = CommsMessage, bound_organization_column()
    query = select(m.id).where(
        m.org_id == org,
        m.conversation_id.in_(readable),
        m.is_deleted.is_(False),
        m.deleted_at.is_(None),
    )
    if request.q:
        query = query.where(m.body_tsv.op("@@")(func.plainto_tsquery("simple", request.q)))
    if request.sender_id:
        query = query.where(m.author_id == request.sender_id)
    if request.conversation_id:
        query = query.where(m.conversation_id == request.conversation_id)
    if request.before:
        query = query.where(m.created_at < _midnight(request.before))
    if request.after:
        query = query.where(
            false()
            if request.after == date.max
            else m.created_at >= _midnight(request.after + timedelta(days=1))
        )
    if request.on:
        query = query.where(m.created_at >= _midnight(request.on))
        if request.on != date.max:
            query = query.where(m.created_at < _midnight(request.on + timedelta(days=1)))
    if request.has == "file":
        query = query.where(
            exists(
                select(CommsMessageAttachment.id)
                .join(
                    File,
                    File.id == CommsMessageAttachment.file_id,
                )
                .where(
                    CommsMessageAttachment.org_id == org,
                    File.org_id == org,
                    CommsMessageAttachment.message_id == m.id,
                    CommsMessageAttachment.is_deleted.is_(False),
                    CommsMessageAttachment.deleted_at.is_(None),
                    File.is_deleted.is_(False),
                    File.deleted_at.is_(None),
                    File.state == "ready",
                    File.purpose == "comms_attachment",
                    File.conversation_id == m.conversation_id,
                )
            ).correlate(m)
        )
    elif request.has == "link":
        query = query.where(m.body.op("~*")(r"https?://"))
    elif request.has == "record":
        query = query.where(
            exists(
                select(CommsMessageRecordLink.id)
                .join(
                    Record,
                    Record.id == CommsMessageRecordLink.record_id,
                )
                .join(Module, Module.id == Record.module_id)
                .where(
                    CommsMessageRecordLink.org_id == org,
                    Record.org_id == org,
                    Module.org_id == org,
                    CommsMessageRecordLink.message_id == m.id,
                    CommsMessageRecordLink.module_id == Record.module_id,
                    CommsMessageRecordLink.is_deleted.is_(False),
                    CommsMessageRecordLink.deleted_at.is_(None),
                    Record.is_deleted.is_(False),
                    Record.deleted_at.is_(None),
                    Module.is_deleted.is_(False),
                    Module.deleted_at.is_(None),
                    module_filter(db, actor, AccessLevel.READ, Record.module_id),
                )
            ).correlate(m)
        )
    if request.state == "pinned":
        query = query.where(m.pinned_at.is_not(None))
    elif request.state == "thread":
        query = query.where(
            or_(
                m.parent_id.is_not(None),
                exists(
                    select(CommsThread.id).where(
                        CommsThread.org_id == org,
                        CommsThread.conversation_id == m.conversation_id,
                        CommsThread.root_message_id == m.id,
                        CommsThread.is_deleted.is_(False),
                    )
                ).correlate(m),
            )
        )
    return query


def query_messages(
    db: Session, actor: User, request: CommsSearchRequest
) -> StandardListResponse[SearchHit]:
    m, c, org = CommsMessage, CommsConversation, bound_organization_column()
    readable = readable_conversation_ids(db, actor)
    rank = (
        func.ts_rank(m.body_tsv, func.plainto_tsquery("simple", request.q))
        if request.q
        else literal(0)
    )
    page = execute_standard_list(
        db,
        _candidates(db, actor, request, readable),
        StandardListRequest[CommsSearchSort](
            limit=request.limit,
            offset=request.offset,
            sort_by=request.sort_by,
            sort_order=request.sort_order,
        ),
        ListQuerySpec(
            sort_fields={
                CommsSearchSort.CREATED: m.created_at.expression,
                CommsSearchSort.RELEVANCE: rank,
            },
            default_sort=CommsSearchSort.RELEVANCE,
            tie_breaker=m.id.expression,
        ),
    )
    # Bodies and identity labels are loaded only for the bounded page, never the whole match set.
    rows = (
        db.execute(
            select(
                m.id.label("message_id"),
                m.conversation_id,
                case((c.kind == "direct", "Direct conversation"), else_=c.name).label(
                    "conversation_name"
                ),
                m.seq,
                m.author_id,
                func.coalesce(func.nullif(User.display_name, ""), User.username).label(
                    "author_name"
                ),
                m.created_at,
                m.body.label("excerpt"),
                m.parent_id,
            )
            .join(c, c.id == m.conversation_id)
            .join(User, User.id == m.author_id)
            .where(
                m.org_id == org,
                c.org_id == org,
                m.id.in_(page.items),
                m.is_deleted.is_(False),
                m.deleted_at.is_(None),
                m.conversation_id.in_(readable),
            )
        )
        .mappings()
        .all()
        if page.items
        else []
    )
    current = readable_conversation_ids(db, actor)
    if (
        readable - current
        or len(rows) != len(page.items)
        or any(row["conversation_id"] not in current for row in rows)
    ):
        # A previous result/total is not a grant. Do not return stale counts or a page with holes.
        refused = error("comms_not_found", "Search source unavailable")
        refused.headers = {"Cache-Control": "private, no-store"}
        raise refused
    lexemes = (
        db.scalar(select(func.tsvector_to_array(func.to_tsvector("simple", request.q))))
        if request.q and rows
        else []
    )
    pattern = (
        re.compile(
            "|".join(re.escape(term) for term in sorted(lexemes or [], key=len, reverse=True)),
            re.IGNORECASE,
        )
        if lexemes
        else None
    )
    projected = {}
    for row in rows:
        # Never use ts_headline HTML. Regex spans index the original Python string's
        # Unicode code points, not a lowercased copy or UTF-16 offsets.
        matches = (
            [
                MatchOffset(start=match.start(), end=match.end())
                for match in pattern.finditer(row["excerpt"])
            ]
            if pattern
            else []
        )
        projected[row["message_id"]] = SearchHit.model_validate({**dict(row), "matches": matches})
    return StandardListResponse(
        items=[projected[identity] for identity in page.items], pagination=page.pagination
    )


router = APIRouter(prefix="/comms", tags=["comms"], dependencies=[Depends(get_current_membership)])


@router.get(
    "/search",
    response_model=StandardListResponse[SearchHit],
    responses={
        404: {"description": "A captured source is no longer readable"},
        503: {"description": "Search unavailable"},
    },
)
def search_messages(
    db: Annotated[Session, Depends(get_db)],
    actor: Annotated[User, Depends(get_account_user)],
    request: Annotated[CommsSearchRequest, Query()],
    response: Response,
) -> StandardListResponse[SearchHit]:
    response.headers["Cache-Control"] = "private, no-store"
    try:
        return query_messages(db, actor, request)
    except SQLAlchemyError as exc:
        db.rollback()
        refused = error("comms_unavailable", "Search unavailable", 503)
        refused.headers = {"Cache-Control": "private, no-store"}
        raise refused from exc
