"""Current authenticated avatar binding checked around unlocked private Storage I/O."""

from enum import IntEnum
from io import BytesIO
from time import sleep
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, Query, Request, Response
from fastapi.security import HTTPAuthorizationCredentials
from PIL import Image, ImageOps
from psycopg.errors import LockNotAvailable
from sqlalchemy import select
from sqlalchemy.exc import OperationalError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import (
    CurrentIdentity,
    get_account_identity,
    get_optional_membership,
    parse_organization_id,
)
from app.core.database import get_db
from app.systems.access.policy.checks import require_live_session
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.membership import organization_required
from app.systems.access.users.person_visibility import profile_person
from app.systems.access.users.profile import ready_avatar
from app.systems.platform.files.access import error, fresh_user
from app.systems.platform.files.delivery import read_content, record_download
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import StorageBackend, file_processing


def get_avatar_identity(
    request: Request,
    user_id: UUID,
    identity: Annotated[CurrentIdentity, Depends(get_account_identity)],
    db: Annotated[Session, Depends(get_db)],
    org: Annotated[str | None, Query(
        description="Organization for avatar visibility (UUID). X-Org takes precedence.",
    )] = None,
    raw_org: Annotated[str | None, Header(
        alias="X-Org", description="Organization for avatar visibility (UUID). Overrides org.",
    )] = None,
) -> CurrentIdentity:
    raw_header = raw_org if raw_org is not None else request.headers.get("X-Org")
    org_id = parse_organization_id(
        raw_header if raw_header is not None else org,
        location=("header", "x-org") if raw_header is not None else ("query", "org"),
    )
    if (
        user_id != identity.user.id
        and get_optional_membership(request, identity, db, org_id) is None
    ):
        raise organization_required()
    return identity


def _bound_avatar(db: Session, identity: CurrentIdentity, target_id: UUID) -> File:
    require_live_session(db, actor_id=identity.user.id, session_id=identity.session_id)
    actor = fresh_user(db, identity.user.id)
    # A photo shows wherever its profile can (PD17).
    target = actor if target_id == actor.id else profile_person(db, actor, target_id)[0]
    db.refresh(target, with_for_update={"read": True, "nowait": True})
    if not is_active_account(db, target):
        raise error("person_not_found", "Person not found", 404)
    if target.avatar_file_id is None:
        raise error("avatar_not_found", "Avatar not found", 404)
    file = db.scalar(
        select(File)
        .where(File.id == target.avatar_file_id)
        .with_for_update(read=True, nowait=True)
        .execution_options(populate_existing=True)
    )
    return ready_avatar(file, target_id)


def _current_avatar(db: Session, identity: CurrentIdentity, target_id: UUID) -> File:
    """``_bound_avatar``, tried again when another request briefly holds a row it locks.

    The locks stay NOWAIT: this read takes the session lock before the person's row,
    the reverse of the writers' order, so it must never wait while it holds the
    session. A refused lock rolls back (releasing the session) and tries again after
    a short pause; a page load's notifications read locks the viewer's row (PD67).
    """
    for pause in AVATAR_LOCK_RETRY_PAUSES:
        try:
            return _bound_avatar(db, identity, target_id)
        except OperationalError as exc:
            if not isinstance(exc.orig, LockNotAvailable):
                raise
            db.rollback()
            sleep(pause)
    return _bound_avatar(db, identity, target_id)


AVATAR_BYTES = 2 * 1024 * 1024
AVATAR_LOCK_RETRY_PAUSES = (0.05, 0.2)


class ThumbnailSize(IntEnum):
    SMALL = 64
    LARGE = 256


def thumbnail(content: bytes, media_type: str, size: int) -> bytes:
    """A square cover crop of validated avatar bytes (D19: FastAPI resizes)."""

    with Image.open(BytesIO(content)) as image:
        image.draft("RGB", (size, size))
        fitted = ImageOps.fit(ImageOps.exif_transpose(image), (size, size))
        output = BytesIO()
        if media_type == "image/png":
            fitted.convert("RGBA").save(output, format="PNG", optimize=True)
        else:
            fitted.convert("RGB").save(output, format="JPEG", quality=85)
        return output.getvalue()


def deliver_avatar(
    request: Request,
    db: Session,
    identity: CurrentIdentity,
    target_id: UUID,
    storage: StorageBackend,
    bearer: HTTPAuthorizationCredentials | None,
    thumbnail_size: ThumbnailSize | None = None,
) -> Response:
    # A page shows several sizes of one photo at once; queue for a processing slot and
    # the photo's bytes instead of refusing a read (PD67). Return the pooled
    # connection first: every check below runs again in a new transaction.
    db.rollback()
    with file_processing(AVATAR_BYTES):
        try:
            file = _current_avatar(db, identity, target_id)
            file_id, digest, size = file.id, file.digest, file.actual_size
            content, media_type, _ = read_content(db, file, storage)
            # Reuse the complete existing resolver, not merely a pre-I/O user snapshot.
            current = get_avatar_identity(
                request, target_id, get_account_identity(request, bearer, db), db,
                request.query_params.get("org"),
            )
            file = _current_avatar(db, current, target_id)
            if file.id != file_id or file.digest != digest or file.actual_size != size:
                raise error("avatar_changed", "Avatar changed; reload", 409)
            db.commit()
            record_download(current.user.id, file_id)
        except SQLAlchemyError as exc:
            db.rollback()
            raise error("avatar_unavailable", "Avatar is unavailable", 503) from exc
        if thumbnail_size is not None:
            content = thumbnail(content, media_type, thumbnail_size)
        return Response(
            content,
            media_type=media_type,
            headers={
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": "inline",
            },
        )
