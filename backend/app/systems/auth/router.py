from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.common.dependencies import (
    get_current_user,
    get_verified_pending_identity,
    require_roles,
)
from app.common.dependencies.auth import VerifiedPendingIdentity
from app.core.database import get_db
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import User, UserRole
from app.systems.users.permissions import effective_permissions
from app.systems.users.router import roles_router
from app.systems.users.router import router as users_router
from app.systems.users.schemas import AuthMeResponse, UserResponse
from app.systems.users.service import (
    InvitationConflict,
    InvitationError,
    accept_verified_invitation,
    invite_user,
    resend_invitation,
)

auth_router = APIRouter(prefix="/auth", tags=["auth"])
router = APIRouter()


@auth_router.post("/invitations", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def invite(
    payload: InvitationCreate,
    admin: Annotated[User, Depends(require_roles(UserRole.ADMIN))],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    try:
        return invite_user(db, payload, actor_id=admin.id)
    except InvitationConflict as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email or username is already in use",
        ) from error
    except InvitationError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to send invitation",
        ) from error


@auth_router.post(
    "/invitations/{user_id}/resend",
    response_model=UserResponse,
)
def resend(
    user_id: UUID,
    admin: Annotated[User, Depends(require_roles(UserRole.ADMIN))],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    try:
        return resend_invitation(db, user_id, actor_id=admin.id)
    except InvitationConflict as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except InvitationError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to resend invitation",
        ) from error


@auth_router.post("/invitations/accept", response_model=UserResponse)
def accept_invitation(
    identity: Annotated[VerifiedPendingIdentity, Depends(get_verified_pending_identity)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    try:
        return accept_verified_invitation(
            db,
            identity.subject,
            verified_email=identity.email,
            verified_identity=identity.subject,
        )
    except InvitationConflict as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except InvitationError as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Invitation cannot be accepted",
        ) from error


@auth_router.get("/me", response_model=AuthMeResponse)
def me(user: Annotated[User, Depends(get_current_user)]) -> AuthMeResponse:
    return AuthMeResponse.model_validate(
        {
            **UserResponse.model_validate(user).model_dump(),
            "role": user.role.role,
            "permissions": effective_permissions(user.role),
        }
    )


# The current application registration includes only this exported router.
router.include_router(auth_router)
router.include_router(users_router)
router.include_router(roles_router)
