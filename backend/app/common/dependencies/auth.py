from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, joinedload

from app.common.normalization import normalize_email
from app.core.database import get_db
from app.core.security.supabase import verify_supabase_jwt
from app.systems.audit.context import set_audit_actor
from app.systems.users.models import Role, User, UserRole
from app.systems.users.permissions import Capability, has_capability

oauth2_scheme = HTTPBearer(auto_error=True)


@dataclass(frozen=True, slots=True)
class VerifiedPendingIdentity:
    """Identity claims verified by Supabase for invitation acceptance."""

    subject: UUID
    email: str


def get_current_user(
    token: Annotated[str | HTTPAuthorizationCredentials, Depends(oauth2_scheme)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    raw_token = token.credentials if isinstance(token, HTTPAuthorizationCredentials) else token
    claims = verify_supabase_jwt(raw_token)
    subject = claims.get("sub") if claims else None
    try:
        user_id = UUID(subject) if subject else None
    except ValueError:
        user_id = None
    user = (
        db.scalar(select(User).options(joinedload(User.role)).where(User.id == user_id))
        if user_id
        else None
    )
    if (
        user is None
        or user.id != user_id
        or user.is_deleted
        or getattr(user, "status", None) != "active"
        or user.role is None
        or user.role.is_deleted
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    tokens_valid_after = getattr(user, "tokens_valid_after", None)
    if tokens_valid_after is not None:
        issued_at = claims.get("iat") if claims is not None else None
        try:
            if not isinstance(issued_at, (int, float)) or isinstance(issued_at, bool):
                raise TypeError
            issued_at_timestamp = float(issued_at)
            cutoff = (
                tokens_valid_after
                if tokens_valid_after.tzinfo is not None
                else tokens_valid_after.replace(tzinfo=UTC)
            )
            issued_at_datetime = datetime.fromtimestamp(issued_at_timestamp, tz=UTC)
        except (AttributeError, OverflowError, OSError, TypeError, ValueError):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication credentials",
                headers={"WWW-Authenticate": "Bearer"},
            ) from None
        if issued_at_datetime < cutoff:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication credentials",
                headers={"WWW-Authenticate": "Bearer"},
            )
    # SQLAlchemy sessions expose a mutable ``info`` dict. The guard keeps the
    # dependency usable with lightweight session doubles while preserving the
    # actor assignment for every real request session.
    if isinstance(db.info, dict):
        set_audit_actor(db, user.id)
    return user


def get_verified_pending_identity(
    token: Annotated[str | HTTPAuthorizationCredentials, Depends(oauth2_scheme)],
) -> VerifiedPendingIdentity:
    """Verify JWT claims without requiring the local profile to be active yet."""

    raw_token = token.credentials if isinstance(token, HTTPAuthorizationCredentials) else token
    claims = verify_supabase_jwt(raw_token)
    subject = claims.get("sub") if claims else None
    email = claims.get("email") if claims else None
    try:
        user_id = UUID(subject) if isinstance(subject, str) else None
        normalized_email = normalize_email(email) if isinstance(email, str) else None
    except (TypeError, ValueError):
        user_id = None
        normalized_email = None
    if user_id is None or normalized_email is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return VerifiedPendingIdentity(subject=user_id, email=normalized_email)


def require_fresh_exact_admin(db: Session, actor_id: UUID) -> User:
    """Lock the literal admin role and reload the authorized actor from the database."""

    try:
        admin_role = db.scalar(
            select(Role)
            .where(Role.role == UserRole.ADMIN, Role.is_deleted.is_(False))
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to lock administrator membership",
        ) from error
    if not isinstance(admin_role, Role):
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to lock administrator membership",
        )

    try:
        actor = db.scalar(
            select(User)
            .options(joinedload(User.role))
            .where(User.id == actor_id)
            .execution_options(populate_existing=True)
            .with_for_update(of=User)
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reload administrator",
        ) from error
    if not isinstance(actor, User):
        db.rollback()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    if not (
        actor.id == actor_id
        and actor.status == "active"
        and not actor.is_deleted
        and actor.role_id == admin_role.id
        and actor.role is not None
        and actor.role.id == admin_role.id
        and not actor.role.is_deleted
        and actor.role.role == UserRole.ADMIN
    ):
        db.rollback()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
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
