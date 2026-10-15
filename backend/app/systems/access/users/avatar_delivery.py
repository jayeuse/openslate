"""Current authenticated avatar binding checked around unlocked private Storage I/O."""

from uuid import UUID

from fastapi import Request, Response
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.systems.access.policy.checks import require_live_session
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.person_visibility import visible_person
from app.systems.access.users.profile import ready_avatar
from app.systems.platform.files.access import error, fresh_user
from app.systems.platform.files.delivery import read_content, record_download
from app.systems.platform.files.models import File
from app.systems.platform.files.providers import StorageBackend, transfer_slot


def _bound_avatar(db: Session, identity: CurrentIdentity, target_id: UUID) -> File:
    require_live_session(db, actor_id=identity.user.id, session_id=identity.session_id)
    actor = fresh_user(db, identity.user.id)
    target = actor if target_id == actor.id else visible_person(db, actor, target_id)
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


def deliver_avatar(
    request: Request,
    db: Session,
    identity: CurrentIdentity,
    target_id: UUID,
    storage: StorageBackend,
    bearer: HTTPAuthorizationCredentials | None,
) -> Response:
    with transfer_slot():
        try:
            file = _bound_avatar(db, identity, target_id)
            file_id, digest, size = file.id, file.digest, file.actual_size
            content, media_type, _ = read_content(db, file, storage)
            # Reuse the complete existing resolver, not merely a pre-I/O user snapshot.
            current = get_current_identity(request, bearer, db)
            file = _bound_avatar(db, current, target_id)
            if file.id != file_id or file.digest != digest or file.actual_size != size:
                raise error("avatar_changed", "Avatar changed; reload", 409)
            db.commit()
            record_download(current.user.id, file_id)
        except SQLAlchemyError as exc:
            db.rollback()
            raise error("avatar_unavailable", "Avatar is unavailable", 503) from exc
        return Response(
            content,
            media_type=media_type,
            headers={
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": "inline",
            },
        )
