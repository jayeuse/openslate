from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.core.security import hash_password, verify_password
from app.core.security.tokens import create_access_token
from app.systems.auth.schemas import RegistrationRequest, TokenResponse
from app.systems.users.models import Role, User, UserRole
from app.systems.users.schemas import UserResponse

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def register(payload: RegistrationRequest, db: Annotated[Session, Depends(get_db)]) -> User:
    role = db.scalar(
        select(Role).where(Role.role == UserRole.MEMBER, Role.is_deleted.is_(False))
    )
    if role is None:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Default member role is not configured",
        )
    user = User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role_id=role.id,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username unavailable",
        ) from error
    db.refresh(user)
    return user


@router.post("/token", response_model=TokenResponse)
def login(
    form: Annotated[OAuth2PasswordRequestForm, Depends()],
    db: Annotated[Session, Depends(get_db)],
) -> TokenResponse:
    username = form.username.lower()
    user = db.scalar(select(User).where(User.username == username))
    if user is None or user.is_deleted or not verify_password(form.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return TokenResponse(access_token=create_access_token(str(user.id)))


@router.get("/me", response_model=UserResponse)
def me(user: Annotated[User, Depends(get_current_user)]) -> User:
    return user
