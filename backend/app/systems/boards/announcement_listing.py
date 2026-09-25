"""Board announcement list ordering and authoring visibility queries."""

from typing import Any, cast

from sqlalchemy import and_, literal, or_
from sqlalchemy.sql import Select
from sqlalchemy.sql.elements import ColumnElement

from app.common.listing import ListQuerySpec
from app.systems.access.users.models import User
from app.systems.boards.announcement_models import BoardAnnouncement, BoardAnnouncementRevision
from app.systems.boards.announcement_schemas import AnnouncementSort, AnnouncementView
from app.systems.boards.announcement_service import audience_clause


def list_spec(view: AnnouncementView) -> ListQuerySpec[AnnouncementSort]:
    source = BoardAnnouncementRevision if view is AnnouncementView.PUBLISHED else BoardAnnouncement
    return ListQuerySpec(
        sort_fields={
            AnnouncementSort.CREATED_AT: cast(ColumnElement[Any], source.created_at),
            AnnouncementSort.UPDATED_AT: cast(ColumnElement[Any], source.updated_at),
            AnnouncementSort.TITLE: cast(ColumnElement[Any], source.title),
        },
        default_sort=AnnouncementSort.UPDATED_AT,
        tie_breaker=cast(ColumnElement[Any], BoardAnnouncement.id),
        search_fields=(
            cast(ColumnElement[str], source.title),
            cast(ColumnElement[str], source.body),
        ),
        deleted_field=None,
    )


def display_join() -> ColumnElement[bool]:
    return and_(
        BoardAnnouncementRevision.announcement_id == BoardAnnouncement.id,
        BoardAnnouncementRevision.publication_number
        == BoardAnnouncement.displayed_publication_number,
        BoardAnnouncementRevision.is_deleted.is_(False),
        BoardAnnouncementRevision.deleted_at.is_(None),
    )


def editable_statement(
    base: Select[tuple[BoardAnnouncement]], actor: User, manager: bool
) -> Select[tuple[BoardAnnouncement]]:
    return base.outerjoin(BoardAnnouncementRevision, display_join()).where(
        BoardAnnouncement.status.in_(("draft", "scheduled", "published")),
        or_(
            BoardAnnouncement.author_id == actor.id,
            and_(
                literal(manager),
                audience_clause(BoardAnnouncement, actor),
                or_(
                    BoardAnnouncement.status.in_(("draft", "scheduled")),
                    and_(
                        BoardAnnouncement.status == "published",
                        audience_clause(BoardAnnouncementRevision, actor),
                    ),
                ),
            ),
        ),
    )
