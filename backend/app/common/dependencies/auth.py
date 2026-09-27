from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.config.development import browser_origin_is_permitted
from app.core.database import get_db
from app.core.integrations.supabase_auth import (
    InvalidProviderToken,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_sessions import resolve_provider_session, validate_csrf
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.models import User, UserRole
from app.systems.manage.audit.context import set_audit_actor

_bearer = HTTPBearer(auto_error=False)
_UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# One transaction-scoped advisory lock orders administrator membership changes.
# Administrator actions hold it shared; changes that can remove an administrator
# hold it exclusively, so the last-administrator count cannot race.
ADMINISTRATOR_CHANGE_LOCK = 0x4F53_4144  # "OSAD"


@dataclass(frozen=True, slots=True)
class CurrentIdentity:
    user: User
    session_id: UUID
    cookie_authenticated: bool
    setup_only: bool


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_identity(
    request: Request,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    db: Annotated[Session, Depends(get_db)],
) -> CurrentIdentity:
    cookie_token = request.cookies.get("openslate_access")
    refresh_cookie = request.cookies.get("openslate_refresh")
    bearer_token = bearer.credentials if bearer is not None else None
    if request.headers.get("authorization") and (cookie_token or refresh_cookie):
        raise _unauthorized()
    if bool(cookie_token) == bool(bearer_token):
        raise _unauthorized()
    raw_token = cookie_token or bearer_token
    if raw_token is None:
        raise _unauthorized()
    client = get_supabase_auth_client()
    try:
        claims = client.verify_access_token(raw_token)
        resolved = resolve_provider_session(db, claims, client)
    except InvalidProviderToken as error:
        raise _unauthorized() from error
    except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
        raise HTTPException(status_code=503, detail="Authentication service unavailable") from error
    if resolved is None:
        raise _unauthorized()
    user, session = resolved
    session_id = session.id
    cookie_authenticated = cookie_token is not None
    if cookie_authenticated and request.method in _UNSAFE_METHODS:
        _validate_cookie_mutation(request, db, session_id)
    if isinstance(db.info, dict):
        set_audit_actor(db, user.id)
    return CurrentIdentity(user, session_id, cookie_authenticated, False)


def _validate_cookie_mutation(request: Request, db: Session, session_id: UUID) -> None:
    if not browser_origin_is_permitted(get_settings(), request.headers.get("origin")):
        raise _unauthorized()
    session = db.get(IdentitySession, session_id)
    if session is None or not validate_csrf(session, request.headers.get("X-CSRF-Token", "")):
        raise _unauthorized()


def get_current_user(identity: Annotated[CurrentIdentity, Depends(get_current_identity)]) -> User:
    if identity.setup_only:
        raise _unauthorized()
    return identity.user


def _forbidden(db: Session) -> HTTPException:
    db.rollback()
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def lock_administrator_changes(db: Session, *, exclusive: bool) -> None:
    """Take the transaction-scoped administrator membership lock."""

    lock = func.pg_advisory_xact_lock if exclusive else func.pg_advisory_xact_lock_shared
    db.execute(select(lock(ADMINISTRATOR_CHANGE_LOCK)))


def require_fresh_exact_admin(
    db: Session, actor_id: UUID, *, serialize_admin_changes: bool = False
) -> User:
    """Reload the actor under the administrator lock and require an active administrator."""

    try:
        lock_administrator_changes(db, exclusive=serialize_admin_changes)
        actor = db.scalar(
            select(User)
            .where(User.id == actor_id)
            .execution_options(populate_existing=True)
            .with_for_update(of=User, read=True)
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Unable to reload administrator") from error
    if (
        not isinstance(actor, User)
        or actor.role != UserRole.ADMIN.value
        or not is_active_account(actor)
    ):
        raise _forbidden(db)
    return actor


def require_admin(user: Annotated[User, Depends(get_current_user)]) -> User:
    """Allow only an administrator.

    Administrators alone change the schema, users, invitations and group access.
    Department managers change group members through ``policy/delegation.py`` instead.
    """

    if user.role != UserRole.ADMIN.value:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return user


def require_non_guest(user: Annotated[User, Depends(get_current_user)]) -> User:
    """Allow administrators and members. A guest is limited to reading."""

    if user.role == UserRole.GUEST.value:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return user
