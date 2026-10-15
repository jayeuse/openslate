"""User listing, retrieval, and invitation-backed creation endpoints."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user, require_admin
from app.common.dependencies.auth import (
    CurrentIdentity,
    _bearer,
    get_account_user,
    get_current_identity,
)
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.auth.cookies import clear_browser_session
from app.systems.access.policy.scope import explain_access
from app.systems.access.users.avatar_delivery import deliver_avatar
from app.systems.access.users.coordination import (
    InvitationConflict,
    InvitationError,
    ProfileValidationError,
    not_found,
)
from app.systems.access.users.coordination import (
    get_user as load_user,
)
from app.systems.access.users.directory import (
    UserListRequest,
    UserSummaryRequest,
    directory_list,
    directory_summary,
)
from app.systems.access.users.directory import UserSortField as UserSortField
from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import Membership, User
from app.systems.access.users.person_visibility import visible_person
from app.systems.access.users.schemas import (
    InvitationCreate,
    InvitationResponse,
    PersonCardPublicResponse,
    PersonCardResponse,
    UserAccessResponse,
    UserCreate,
    UserListResponse,
    UserMfaResetRequest,
    UserMfaResetResponse,
    UserPreferencesResponse,
    UserPreferencesUpdate,
    UserRecoveryRequest,
    UserRecoveryResponse,
    UserResponse,
    UserSecurityResponse,
    UserSummaryResponse,
    invitation_response,
)
from app.systems.access.users.security import read_security, recover_person, reset_person_mfa
from app.systems.access.users.service import (
    invite_user,
)
from app.systems.platform.files.providers import StorageBackend
from app.systems.platform.files.storage import get_storage

router = APIRouter(prefix="/users", tags=["users"])
AdminUser = Annotated[User, Depends(require_admin)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("", response_model=UserListResponse)
def list_users(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[UserListRequest, Query()],
    response: Response,
) -> UserListResponse:
    response.headers["Cache-Control"] = "no-store"
    return directory_list(db, params, utc_now(), org_id=sole_active_membership(db, _.id).org_id)


@router.get("/summary", response_model=UserSummaryResponse)
def user_summary(
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[UserSummaryRequest, Query()],
    response: Response,
) -> UserSummaryResponse:
    response.headers["Cache-Control"] = "no-store"
    return directory_summary(
        db, utc_now(), params.inactive_days, org_id=sole_active_membership(db, _.id).org_id
    )


@router.get("/{user_id}", response_model=UserResponse)
def get_user(
    user_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> UserResponse:
    user = load_user(db, user_id)
    if user.is_deleted:
        raise not_found("User")
    membership = db.scalars(select(Membership).where(
        Membership.user_id == user.id, Membership.org_id == sole_active_membership(db, _.id).org_id
    )).one()
    return UserResponse(**{key: getattr(
        user if key in User.__table__.columns else membership, key
    ) for key in UserResponse.model_fields})


@router.get("/{user_id}/preferences", response_model=UserPreferencesResponse)
def get_user_preferences(
    user_id: UUID, actor: Annotated[User, Depends(get_account_user)], response: Response
) -> UserPreferencesResponse:
    if user_id != actor.id:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "preferences_owner_mismatch",
                "message": "Preferences belong to the authenticated user",
            },
        )
    response.headers["Cache-Control"] = "no-store"
    return UserPreferencesResponse.model_validate(
        {"user_id": actor.id, "theme": actor.theme_preference, "appearance": actor.appearance}
    )


@router.get("/{user_id}/card", response_model=PersonCardResponse | PersonCardPublicResponse)
def get_person_card(
    user_id: UUID,
    actor: CurrentUser,
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> PersonCardResponse | PersonCardPublicResponse:
    target = visible_person(db, actor, user_id)
    response.headers["Cache-Control"] = "private, no-store"
    public = {
        "display_name": target.display_name or target.username,
        "job_title": target.job_title,
        "avatar_url": f"/api/users/{user_id}/avatar" if target.avatar_file_id else None,
    }
    if sole_active_membership(db, actor.id).role == "guest":
        return PersonCardPublicResponse.model_validate(public)
    return PersonCardResponse.model_validate(
        {**public, "email": target.email, "phone": target.phone, "bio": target.bio}
    )


@router.get("/{user_id}/avatar")
def get_person_avatar(
    user_id: UUID,
    request: Request,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
    storage: Annotated[StorageBackend, Depends(get_storage)],
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> Response:
    return deliver_avatar(request, db, identity, user_id, storage, bearer)


@router.patch("/{user_id}/preferences", response_model=UserPreferencesResponse)
def update_user_preferences(
    user_id: UUID,
    payload: UserPreferencesUpdate,
    actor: Annotated[User, Depends(get_account_user)],
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> UserPreferencesResponse:
    if user_id != actor.id:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "preferences_owner_mismatch",
                "message": "Preferences belong to the authenticated user",
            },
        )
    try:
        # Authentication may have read an older preference. Serialize this
        # independent write before deciding whether a same-value update is harmless.
        db.refresh(actor, with_for_update=True)
        changed = False
        if "theme" in payload.model_fields_set and actor.theme_preference != payload.theme:
            actor.theme_preference = payload.theme
            changed = True
        if "appearance" in payload.model_fields_set:
            appearance = {**actor.appearance, **payload.appearance.model_dump(exclude_unset=True)}
            if appearance != actor.appearance:
                actor.appearance = appearance
                changed = True
        if changed:
            db.commit()
            db.refresh(actor)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Unable to update preferences") from error
    response.headers["Cache-Control"] = "no-store"
    return UserPreferencesResponse.model_validate(
        {"user_id": actor.id, "theme": actor.theme_preference, "appearance": actor.appearance}
    )


@router.get("/{user_id}/access", response_model=UserAccessResponse)
def get_user_access(
    user_id: UUID,
    _: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> UserAccessResponse:
    """Show where the person has access and which groups give it."""

    user = load_user(db, user_id)
    if user.is_deleted:
        raise not_found("User")
    access, entries = explain_access(db, user)
    membership = db.scalars(select(Membership).where(
        Membership.user_id == user.id, Membership.org_id == sole_active_membership(db, _.id).org_id
    )).one()
    return UserAccessResponse.model_validate(
        {
            "user_id": user.id,
            "role": membership.role,
            "unrestricted": access.unrestricted,
            "entries": [
                {
                    "department_id": entry.department_id,
                    "module_id": entry.module_id,
                    "level": entry.level,
                    "groups": [
                        {"group_id": group_id, "name": name, "level": level}
                        for group_id, name, level in entry.groups
                    ],
                }
                for entry in entries
            ],
        }
    )


@router.post("", response_model=InvitationResponse, status_code=status.HTTP_201_CREATED)
def create_user(
    payload: UserCreate,
    admin: AdminUser,
    db: Annotated[Session, Depends(get_db)],
) -> InvitationResponse:
    try:
        user = invite_user(
            db,
            InvitationCreate(**payload.model_dump()),
            actor_id=admin.id,
        )
    except InvitationConflict as error:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email or username is already in use",
        ) from error
    except ProfileValidationError as error:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
    except InvitationError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to send invitation",
        ) from error
    org_id = sole_active_membership(db, admin.id).org_id
    membership = db.scalars(select(Membership).filter_by(user_id=user.id, org_id=org_id)).one()
    return invitation_response(user, membership)


@router.get("/{user_id}/security", response_model=UserSecurityResponse)
def get_user_security(
    user_id: UUID,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
    response: Response,
) -> UserSecurityResponse:
    response.headers["Cache-Control"] = "no-store"
    return read_security(db, identity, request, user_id)


@router.post("/{user_id}/recovery", response_model=UserRecoveryResponse)
def recover_user(
    user_id: UUID,
    payload: UserRecoveryRequest,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
    response: Response,
) -> UserRecoveryResponse | Response:
    response.headers["Cache-Control"] = "no-store"
    self_effect = user_id == identity.user.id and payload.revoke_sessions
    try:
        result = recover_person(db, identity, request, user_id, payload.revoke_sessions)
    except HTTPException as error:
        return security_effect_error(error, self_effect)
    if self_effect:
        clear_browser_session(response)
    return result


@router.post("/{user_id}/mfa/reset", response_model=UserMfaResetResponse)
def reset_user_mfa(
    user_id: UUID,
    payload: UserMfaResetRequest,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
    response: Response,
) -> UserMfaResetResponse | Response:
    response.headers["Cache-Control"] = "no-store"
    self_effect = user_id == identity.user.id
    try:
        result = reset_person_mfa(db, identity, request, user_id)
    except HTTPException as error:
        return security_effect_error(error, self_effect)
    if self_effect:
        clear_browser_session(response)
    return result


def security_effect_error(error: HTTPException, self_effect: bool) -> Response:
    response = JSONResponse(
        status_code=error.status_code,
        content={"detail": error.detail},
        headers={"Cache-Control": "no-store"},
    )
    if (
        self_effect
        and isinstance(error.detail, dict)
        and error.detail.get("local_revocation") in {"committed", "unconfirmed"}
    ):
        clear_browser_session(response)
    return response
