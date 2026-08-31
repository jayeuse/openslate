from collections.abc import Callable
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.core.database import get_db
from app.core.security.supabase import verify_supabase_jwt
from app.systems.audit.context import set_audit_actor
from app.systems.users.models import User, UserRole
from app.systems.users.permissions import Capability, has_capability

oauth2_scheme = HTTPBearer(auto_error=True)


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
    # SQLAlchemy sessions expose a mutable ``info`` dict. The guard keeps the
    # dependency usable with lightweight session doubles while preserving the
    # actor assignment for every real request session.
    if isinstance(db.info, dict):
        set_audit_actor(db, user.id)
    return user


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
