from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.common.dependencies import get_current_user
from app.core.database import get_db
from app.core.security import hash_password, verify_password
from app.core.security.tokens import (
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
)
from app.systems.auth.schemas import (
    LoginRequest,
    RefreshRequest,
    RegistrationRequest,
    TokenResponse,
)
from app.systems.users.models import Role, User, UserRole
from app.systems.users.router import roles_router
from app.systems.users.router import router as users_router
from app.systems.users.schemas import UserResponse

auth_router = APIRouter(prefix="/auth", tags=["auth"])
router = APIRouter()


def _token_response(user: User) -> TokenResponse:
    subject = str(user.id)
    return TokenResponse(
        access_token=create_access_token(subject),
        refresh_token=create_refresh_token(subject),
    )


def _authenticate(username: str, password: str, db: Session) -> User:
    user = db.scalar(
        select(User).options(joinedload(User.role)).where(User.username == username.lower())
    )
    if (
        user is None
        or user.is_deleted
        or user.role is None
        or user.role.is_deleted
        or not verify_password(password, user.password_hash)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


@auth_router.post("/register", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
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


@auth_router.post("/token", response_model=TokenResponse)
def login(
    form: Annotated[OAuth2PasswordRequestForm, Depends()],
    db: Annotated[Session, Depends(get_db)],
) -> TokenResponse:
    return _token_response(_authenticate(form.username, form.password, db))


@auth_router.post("/login", response_model=TokenResponse)
def json_login(
    payload: LoginRequest,
    db: Annotated[Session, Depends(get_db)],
) -> TokenResponse:
    return _token_response(_authenticate(payload.username, payload.password, db))


@auth_router.post("/refresh", response_model=TokenResponse)
def refresh(
    payload: RefreshRequest,
    db: Annotated[Session, Depends(get_db)],
) -> TokenResponse:
    subject = decode_refresh_token(payload.refresh_token)
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
            detail="Invalid refresh token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return _token_response(user)


@auth_router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(_: Annotated[User, Depends(get_current_user)]) -> Response:
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@auth_router.get("/me", response_model=UserResponse)
def me(user: Annotated[User, Depends(get_current_user)]) -> User:
    return user


# The current application registration includes only this exported router.
router.include_router(auth_router)
router.include_router(users_router)
router.include_router(roles_router)
