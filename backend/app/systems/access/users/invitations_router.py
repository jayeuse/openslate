"""Administrator controls for pending local invitations."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user, require_admin
from app.core.database import get_db
from app.systems.access.users.coordination import (
    InvitationConflict,
    InvitationError,
    InvitationNotFound,
)
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import Membership, User
from app.systems.access.users.schemas import UserResponse
from app.systems.access.users.service import reconcile_invitation, revoke_invitation

router = APIRouter(prefix="/auth/invitations", tags=["auth"])


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
def revoke_invite(
    user_id: UUID,
    admin: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    try:
        revoke_invitation(db, user_id, actor_id=admin.id)
    except InvitationNotFound as error:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Invitation not found"
        ) from error
    except InvitationConflict as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Invitation is no longer pending"
        ) from error
    except InvitationError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to revoke invitation",
        ) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{user_id}/reconcile", response_model=UserResponse)
def reconcile_invite(
    user_id: UUID,
    admin: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> UserResponse:
    try:
        profile = reconcile_invitation(db, user_id, actor_id=admin.id)
    except InvitationError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Unable to reconcile invitation",
        ) from error
    org_id = sole_active_membership(db, admin.id).org_id
    membership = db.scalars(select(Membership).filter_by(user_id=profile.id, org_id=org_id)).one()
    return UserResponse(**{key: getattr(
        profile if key in User.__table__.columns else membership, key
    ) for key in UserResponse.model_fields})
