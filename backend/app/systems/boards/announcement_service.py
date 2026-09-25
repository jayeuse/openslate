"""Announcement audience queries and ordered, multi-row publication coordination."""

from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID

from fastapi import HTTPException, status
from sqlalchemy import and_, exists, func, or_, select, true
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement
from uuid6 import uuid7

from app.systems.access.identity.eligibility import identity_eligible_clause
from app.systems.access.users.eligibility import established_user_clause
from app.systems.access.users.models import Role, User, UserDepartment, UserStatus
from app.systems.boards.access import can_access_board, can_read_board_grants
from app.systems.boards.announcement_inbox import stage_publication_inbox
from app.systems.boards.announcement_models import (
    BoardAnnouncement,
    BoardAnnouncementRevision,
    publication_content_fingerprint,
)
from app.systems.boards.announcement_schemas import (
    AnnouncementAudience,
    AnnouncementContent,
    AnnouncementMutationResponse,
    AnnouncementPublicationResponse,
    AnnouncementResponse,
)
from app.systems.boards.attachment_models import (
    BoardAnnouncementRevisionAttachment,
    BoardContentAttachment,
)
from app.systems.boards.models import Board, BoardGrant, BoardPermission, BoardStatus
from app.systems.boards.record_link_models import (
    BoardAnnouncementRevisionRecordLink,
    BoardContentRecordLink,
)
from app.systems.manage.audit.context import set_audit_actor
from app.systems.platform.scheduling.models import ScheduledWork
from app.systems.sandbox.departments.models import Department

AnnouncementModel = type[BoardAnnouncement] | type[BoardAnnouncementRevision]


def board_grants(db: Session, board: Board) -> list[BoardGrant]:
    return list(
        db.scalars(
            select(BoardGrant).where(
                BoardGrant.board_id == board.id,
                BoardGrant.is_deleted.is_(False),
                BoardGrant.deleted_at.is_(None),
            )
        ).all()
    )


def read_manager(db: Session, board: Board, actor: User) -> bool:
    return can_read_board_grants(board, actor, board_grants(db, board))


def write_manager(db: Session, board: Board, actor: User) -> bool:
    return can_access_board(board, actor, BoardPermission.MANAGE, board_grants(db, board))


def set_content(item: BoardAnnouncement, content: AnnouncementContent) -> None:
    item.title, item.body = content.title, content.body
    item.links = [link.model_dump() for link in content.links]
    item.expires_at, item.pinned = content.expires_at, content.pinned
    item.audience_kind = content.audience.kind
    item.audience_role_id = content.audience.role_id
    item.audience_user_id = content.audience.user_id
    item.audience_department_id = content.audience.department_id


def current_content(item: BoardAnnouncement) -> AnnouncementContent:
    return AnnouncementContent(
        title=item.title,
        body=item.body,
        links=item.links,
        expires_at=item.expires_at.astimezone(UTC) if item.expires_at else None,
        pinned=item.pinned,
        audience=AnnouncementAudience(
            kind=cast(Any, item.audience_kind),
            role_id=item.audience_role_id,
            user_id=item.audience_user_id,
            department_id=item.audience_department_id,
        ),
    )


def fingerprint(
    item: BoardAnnouncement,
    attachment_file_ids: list[UUID] | None = None,
    record_links: list[tuple[UUID, UUID, str]] | None = None,
) -> str:
    return publication_content_fingerprint(
        author_id=item.author_id,
        title=item.title,
        body=item.body,
        links=item.links,
        audience_kind=item.audience_kind,
        audience_role_id=item.audience_role_id,
        audience_user_id=item.audience_user_id,
        audience_department_id=item.audience_department_id,
        expires_at=item.expires_at,
        attachment_file_ids=attachment_file_ids,
        record_links=record_links,
    )


def published_result(revision: BoardAnnouncementRevision) -> AnnouncementPublicationResponse:
    return AnnouncementPublicationResponse(
        id=revision.id,
        announcement_id=revision.announcement_id,
        publication_number=revision.publication_number,
        publication_key=revision.publication_key,
        published_at=revision.published_at.astimezone(UTC),
    )


def publish_locked(
    db: Session,
    board: Board,
    item: BoardAnnouncement,
    actor: User,
    *,
    publication_key: UUID,
    published_at: datetime,
    board_revision: int,
    announcement_revision: int,
    scheduled_work: ScheduledWork | None = None,
) -> BoardAnnouncementRevision:
    """Stage publication after the caller locks Board then announcement and authorizes the actor.

    The caller owns commit/rollback. Identical-key retries return their existing revision
    before stale-version checks, matching the manual publication contract.
    """
    if (
        item.board_id != board.id
        or board.is_deleted
        or board.deleted_at is not None
        or item.is_deleted
        or item.deleted_at is not None
    ):
        raise not_found()
    if board.status != BoardStatus.ACTIVE or item.status == "archived":
        raise conflict("announcement_unavailable", "Restore before publishing")
    attachment_file_ids = list(
        db.scalars(
            select(BoardContentAttachment.file_id)
            .where(
                BoardContentAttachment.announcement_id == item.id,
                BoardContentAttachment.is_linked.is_(True),
            )
            .order_by(BoardContentAttachment.file_id)
            .with_for_update()
        )
    )
    current_record_links = list(
        db.scalars(
            select(BoardContentRecordLink)
            .where(BoardContentRecordLink.announcement_id == item.id)
            .order_by(BoardContentRecordLink.id)
            .with_for_update()
        )
    )
    content_fingerprint = fingerprint(
        item,
        attachment_file_ids,
        [(link.record_id, link.module_id, link.label) for link in current_record_links],
    )
    prior = db.scalar(
        select(BoardAnnouncementRevision)
        .where(
            BoardAnnouncementRevision.announcement_id == item.id,
            BoardAnnouncementRevision.publication_key == publication_key,
        )
        .with_for_update()
    )
    if prior is not None:
        if prior.content_fingerprint != content_fingerprint or prior.performed_by != actor.id:
            raise conflict(
                "publication_key_conflict", "Publication key was used for different content"
            )
        return prior
    check_board(board, board_revision)
    check_announcement(item, announcement_revision)
    if item.expires_at is not None and item.expires_at <= published_at:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "announcement_expired",
                "message": "Expiration must follow publication",
            },
        )
    active_audience_target(db, current_content(item).audience)
    number = (
        int(
            db.scalar(
                select(func.max(BoardAnnouncementRevision.publication_number)).where(
                    BoardAnnouncementRevision.announcement_id == item.id,
                )
            )
            or 0
        )
        + 1
    )
    published = BoardAnnouncementRevision(
        id=uuid7(),
        announcement_id=item.id,
        publication_number=number,
        publication_key=publication_key,
        content_fingerprint=content_fingerprint,
        author_id=item.author_id,
        title=item.title,
        body=item.body,
        links=[dict(link) for link in item.links],
        audience_kind=item.audience_kind,
        audience_role_id=item.audience_role_id,
        audience_user_id=item.audience_user_id,
        audience_department_id=item.audience_department_id,
        published_at=published_at,
        expires_at=item.expires_at,
    )
    set_audit_actor(db, actor.id)
    db.add(published)
    for file_id in attachment_file_ids:
        db.add(BoardAnnouncementRevisionAttachment(revision_id=published.id, file_id=file_id))
    for link in current_record_links:
        db.add(
            BoardAnnouncementRevisionRecordLink(
                revision_id=published.id,
                record_id=link.record_id,
                module_id=link.module_id,
                label=link.label,
            )
        )
    item.status, item.publish_at = "published", published_at
    item.displayed_publication_number = number
    item.revision += 1
    board.revision += 1
    stage_publication_inbox(
        db,
        board,
        item,
        actor,
        published,
        source_revision=announcement_revision,
        published_at=published_at,
        scheduled_work=scheduled_work,
    )
    return published


def published_expiry(actor: User, manager: bool, now: datetime) -> ColumnElement[bool]:
    if manager:
        return true()
    return or_(
        BoardAnnouncementRevision.expires_at.is_(None),
        BoardAnnouncementRevision.expires_at > now,
        BoardAnnouncement.author_id == actor.id,
    )


def conflict(code: str, message: str, current_revision: int | None = None) -> HTTPException:
    detail: dict[str, str | int] = {"code": code, "message": message}
    if current_revision is not None:
        detail["current_revision"] = current_revision
    return HTTPException(status.HTTP_409_CONFLICT, detail=detail)


def not_found() -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, detail="Board announcement not found")


def audience_clause(model: AnnouncementModel, actor: User) -> ColumnElement[bool]:
    membership = exists(
        select(UserDepartment.id)
        .join(Department, Department.id == UserDepartment.department_id)
        .join(User, User.id == UserDepartment.user_id)
        .where(
            UserDepartment.user_id == actor.id,
            UserDepartment.department_id == model.audience_department_id,
            UserDepartment.is_deleted.is_(False),
            UserDepartment.deleted_at.is_(None),
            Department.is_deleted.is_(False),
            Department.deleted_at.is_(None),
            User.status == UserStatus.ACTIVE.value,
            User.is_deleted.is_(False),
            User.deleted_at.is_(None),
            established_user_clause(),
        )
    )
    no_target = and_(
        model.audience_role_id.is_(None),
        model.audience_user_id.is_(None),
        model.audience_department_id.is_(None),
    )
    return or_(
        and_(model.audience_kind == "everyone", no_target),
        and_(model.audience_kind == "author", model.author_id == actor.id, no_target),
        and_(
            model.audience_kind == "role",
            model.audience_role_id == actor.role_id,
            model.audience_user_id.is_(None),
            model.audience_department_id.is_(None),
        ),
        and_(
            model.audience_kind == "user",
            model.audience_user_id == actor.id,
            model.audience_role_id.is_(None),
            model.audience_department_id.is_(None),
        ),
        and_(
            model.audience_kind == "department",
            membership,
            model.audience_role_id.is_(None),
            model.audience_user_id.is_(None),
        ),
    )


def active_audience_target(db: Session, audience: AnnouncementAudience) -> None:
    if audience.kind == "role":
        target = db.scalar(
            select(Role.id)
            .where(
                Role.id == audience.role_id, Role.is_deleted.is_(False), Role.deleted_at.is_(None)
            )
            .with_for_update()
        )
    elif audience.kind == "user":
        target = db.scalar(
            select(User.id)
            .join(Role, Role.id == User.role_id)
            .where(
                User.id == audience.user_id,
                User.status == UserStatus.ACTIVE.value,
                User.is_deleted.is_(False),
                User.deleted_at.is_(None),
                identity_eligible_clause(),
                Role.is_deleted.is_(False),
                Role.deleted_at.is_(None),
                established_user_clause(),
            )
            .with_for_update(of=User)
        )
    elif audience.kind == "department":
        target = db.scalar(
            select(Department.id)
            .where(
                Department.id == audience.department_id,
                Department.is_deleted.is_(False),
                Department.deleted_at.is_(None),
            )
            .with_for_update()
        )
    else:
        return
    if target is None:
        raise conflict("audience_unavailable", "The selected audience is unavailable")


def announcement(
    db: Session, board_id: UUID, announcement_id: UUID, actor: User, *, lock: bool = False
) -> BoardAnnouncement:
    statement = select(BoardAnnouncement).where(
        BoardAnnouncement.id == announcement_id,
        BoardAnnouncement.board_id == board_id,
        BoardAnnouncement.is_deleted.is_(False),
        BoardAnnouncement.deleted_at.is_(None),
        or_(
            audience_clause(BoardAnnouncement, actor),
            BoardAnnouncement.author_id == actor.id,
        ),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    found = db.scalar(statement)
    if found is None:
        raise not_found()
    return found


def displayed_revision(
    db: Session, announcement: BoardAnnouncement, *, lock: bool = False
) -> BoardAnnouncementRevision | None:
    number = announcement.displayed_publication_number
    if number is None:
        return None
    statement = select(BoardAnnouncementRevision).where(
        BoardAnnouncementRevision.announcement_id == announcement.id,
        BoardAnnouncementRevision.publication_number == number,
        BoardAnnouncementRevision.is_deleted.is_(False),
        BoardAnnouncementRevision.deleted_at.is_(None),
    )
    if lock:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    revision = db.scalar(statement)
    if revision is None:
        raise conflict("publication_invalid", "The displayed publication is unavailable")
    return revision


def revision_visible(db: Session, revision: BoardAnnouncementRevision, actor: User) -> bool:
    return (
        db.scalar(
            select(BoardAnnouncementRevision.id).where(
                BoardAnnouncementRevision.id == revision.id,
                audience_clause(BoardAnnouncementRevision, actor),
            )
        )
        is not None
    )


def actionable(
    db: Session, board_id: UUID, announcement_id: UUID, actor: User
) -> tuple[BoardAnnouncement, BoardAnnouncementRevision | None]:
    """Call only after taking the Board FOR UPDATE lock; then lock child and snapshot."""
    item = announcement(db, board_id, announcement_id, actor, lock=True)
    displayed = displayed_revision(db, item, lock=True)
    if (
        displayed is not None
        and item.author_id != actor.id
        and not revision_visible(db, displayed, actor)
    ):
        raise not_found()
    return item, displayed


def check_board(board: Board, revision: int) -> None:
    if board.revision != revision:
        raise conflict(
            "stale_board_revision", "Board changed; reload before saving", board.revision
        )
    if board.status != BoardStatus.ACTIVE:
        raise conflict("board_archived", "Restore the Board before changing announcements")


def check_announcement(item: BoardAnnouncement, revision: int) -> None:
    if item.revision != revision:
        raise conflict(
            "stale_announcement_revision",
            "Announcement changed; reload before saving",
            item.revision,
        )


def commit(db: Session) -> None:
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise conflict("announcement_conflict", "Unable to save Board announcement") from error
    except SQLAlchemyError:
        db.rollback()
        raise


def audience(item: BoardAnnouncement | BoardAnnouncementRevision) -> AnnouncementAudience:
    return AnnouncementAudience(
        kind=cast(Any, item.audience_kind),
        role_id=item.audience_role_id,
        user_id=item.audience_user_id,
        department_id=item.audience_department_id,
    )


def response(
    item: BoardAnnouncement, board: Board, published: BoardAnnouncementRevision | None = None
) -> AnnouncementResponse:
    source = published if published is not None else item
    return AnnouncementResponse(
        id=item.id,
        board_id=item.board_id,
        author_id=source.author_id,
        title=source.title,
        body=source.body,
        links=source.links,
        audience=audience(source),
        status="published" if published is not None else item.status,
        publish_at=published.published_at.astimezone(UTC) if published else item.publish_at,
        expires_at=source.expires_at.astimezone(UTC) if source.expires_at else None,
        pinned=item.pinned,
        announcement_revision=None if published is not None else item.revision,
        board_revision=board.revision,
        publication_number=published.publication_number if published else None,
        published_at=published.published_at.astimezone(UTC) if published else None,
        created_at=published.created_at if published is not None else item.created_at,
        updated_at=published.updated_at if published is not None else item.updated_at,
    )


def mutation(item: BoardAnnouncement, board: Board) -> AnnouncementMutationResponse:
    return AnnouncementMutationResponse(
        id=item.id, announcement_revision=item.revision, board_revision=board.revision
    )
