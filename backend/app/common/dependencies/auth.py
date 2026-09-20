from collections.abc import Callable
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, joinedload

from app.core.config import get_settings
from app.core.database import get_db
from app.core.security.tokens import TokenType, decode_token
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.service import validate_access_session, validate_csrf
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import Role, User, UserRole
from app.systems.access.users.permissions import Capability, has_capability
from app.systems.manage.audit.context import set_audit_actor

_bearer = HTTPBearer(auto_error=False)
_UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


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
    claims = decode_token(raw_token, TokenType.ACCESS)
    if claims is None:
        raise _unauthorized()
    user = validate_access_session(db, claims, allow_setup=claims.get("setup") is True)
    if user is None:
        raise _unauthorized()
    session_id = UUID(str(claims["sid"]))
    cookie_authenticated = cookie_token is not None
    if cookie_authenticated and request.method in _UNSAFE_METHODS:
        _validate_cookie_mutation(request, db, session_id)
    if isinstance(db.info, dict):
        set_audit_actor(db, user.id)
    return CurrentIdentity(user, session_id, cookie_authenticated, claims.get("setup") is True)


def _validate_cookie_mutation(request: Request, db: Session, session_id: UUID) -> None:
    origin = request.headers.get("origin")
    if origin is None or origin not in get_settings().cors_origins:
        raise _unauthorized()
    session = db.get(IdentitySession, session_id)
    if session is None or not validate_csrf(session, request.headers.get("X-CSRF-Token", "")):
        raise _unauthorized()


def get_current_user(identity: Annotated[CurrentIdentity, Depends(get_current_identity)]) -> User:
    if identity.setup_only:
        raise _unauthorized()
    return identity.user


def require_fresh_exact_admin(db: Session, actor_id: UUID) -> User:
    try:
        admin_role = db.scalar(
            select(Role)
            .where(Role.role == UserRole.ADMIN, Role.is_deleted.is_(False))
            .execution_options(populate_existing=True)
            .with_for_update()
        )
        actor = db.scalar(
            select(User)
            .options(joinedload(User.role))
            .where(User.id == actor_id)
            .execution_options(populate_existing=True)
            .with_for_update(of=User)
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Unable to reload administrator") from error
    if not isinstance(admin_role, Role) or not isinstance(actor, User):
        db.rollback()
        raise HTTPException(status_code=403, detail="Forbidden")
    if not (
        actor.status == "active"
        and is_established_user(actor)
        and not actor.is_deleted
        and actor.role_id == admin_role.id
        and actor.role is not None
        and not actor.role.is_deleted
    ):
        db.rollback()
        raise HTTPException(status_code=403, detail="Forbidden")
    return actor


def require_roles(*roles: UserRole | str) -> Callable[[User], User]:
    def check_role(user: Annotated[User, Depends(get_current_user)]) -> User:
        allowed_roles = {role.value if isinstance(role, UserRole) else role for role in roles}
        if user.role.role not in allowed_roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return user

    return check_role


def require_capability(capability: Capability | str) -> Callable[[User], User]:
    required_capability = Capability(capability)

    def check_capability(user: Annotated[User, Depends(get_current_user)]) -> User:
        if not has_capability(user.role, required_capability):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return user

    return check_capability
