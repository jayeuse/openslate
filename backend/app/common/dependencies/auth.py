from collections.abc import Callable
from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.core.database import get_db
from app.core.security.tokens import decode_access_token
from app.systems.audit.context import set_audit_actor
from app.systems.users.models import User, UserRole

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/token")


def get_current_user(
    token: Annotated[str, Depends(oauth2_scheme)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    subject = decode_access_token(token)
    try:
        user_id = UUID(subject) if subject else None
    except ValueError:
        user_id = None
    user = (
        db.scalar(select(User).options(joinedload(User.role)).where(User.id == user_id))
        if user_id
        else None
    )
    if user is None or user.is_deleted or user.role is None or user.role.is_deleted:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )
    set_audit_actor(db, user.id)
    return user


def require_roles(*roles: UserRole | str) -> Callable[[User], User]:
    def check_role(user: Annotated[User, Depends(get_current_user)]) -> User:
        allowed_roles = {role.value if isinstance(role, UserRole) else role for role in roles}
        if user.role.role not in allowed_roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return user

    return check_role
