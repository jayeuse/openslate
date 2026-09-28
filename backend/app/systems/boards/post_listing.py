"""Board post list ordering and authoring visibility queries."""

from typing import Any, cast

from sqlalchemy import and_, literal, or_
from sqlalchemy.sql import Select
from sqlalchemy.sql.elements import ColumnElement

from app.common.listing import ListQuerySpec
from app.systems.access.users.models import User
from app.systems.boards.post_models import BoardPost, BoardPostRevision
from app.systems.boards.post_schemas import PostSort, PostView


def list_spec(view: PostView) -> ListQuerySpec[PostSort]:
    source = BoardPostRevision if view is PostView.PUBLISHED else BoardPost
    return ListQuerySpec(
        sort_fields={
            PostSort.CREATED_AT: cast(ColumnElement[Any], source.created_at),
            PostSort.UPDATED_AT: cast(ColumnElement[Any], source.updated_at),
            PostSort.TITLE: cast(ColumnElement[Any], source.title),
        },
        default_sort=PostSort.UPDATED_AT,
        tie_breaker=cast(ColumnElement[Any], BoardPost.id),
        search_fields=(
            cast(ColumnElement[str], source.title),
            cast(ColumnElement[str], source.body),
        ),
        deleted_field=None,
    )


def display_join() -> ColumnElement[bool]:
    return and_(
        BoardPostRevision.post_id == BoardPost.id,
        BoardPostRevision.publication_number == BoardPost.displayed_publication_number,
        BoardPostRevision.is_deleted.is_(False),
        BoardPostRevision.deleted_at.is_(None),
    )


def editable_statement(
    base: Select[tuple[BoardPost]], actor: User, manager: bool
) -> Select[tuple[BoardPost]]:
    """Posts the actor can change: their own, or every live post for a manager."""

    return base.where(
        BoardPost.status.in_(("draft", "scheduled", "published")),
        or_(BoardPost.author_id == actor.id, literal(manager)),
    )
