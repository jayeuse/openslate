"""OpenSlate-local authentication and user administration routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import (
    CurrentIdentity,
    get_current_identity,
    get_current_user,
    require_roles,
)
from app.core.base_model import utc_now
from app.core.config import get_settings
from app.core.config.development import browser_origin_is_permitted, is_relaxed_development
from app.core.database import get_db
from app.systems.access.auth.cookies import (
    clear_browser_session as _clear_browser_session,
)
from app.systems.access.auth.cookies import (
    cleared_auth_error as _cleared_auth_error,
)
from app.systems.access.auth.cookies import (
    set_browser_session as _set_browser_session,
)
from app.systems.access.auth.request_security import (
    bearer_credentials as _bearer_credentials,
)
from app.systems.access.auth.request_security import (
    reject_mixed_credentials as _reject_mixed_credentials,
)
from app.systems.access.auth.request_security import (
    require_completed_identity as _require_completed_identity,
)
from app.systems.access.auth.request_security import source as _source
from app.systems.access.identity import eligibility, recovery
from app.systems.access.identity.models import ActionTokenPurpose
from app.systems.access.identity.rate_limits import invitation_completion_permitted
from app.systems.access.identity.schemas import (
    ActionTokenCompleteRequest,
    LoginRequest,
    PasswordChangeRequest,
    RecoveryRequest,
    RefreshTokenRequest,
    TokenResponse,
)
from app.systems.access.identity.service import (
    ActionTokenInvalid,
    IdentityRateLimited,
    InvalidCredentials,
    RefreshReplayDetected,
    authenticate_password,
    consume_action_token,
    issue_session,
    recovery_request_permitted,
    refresh_session,
    replace_password,
    revoke_refresh_session,
    revoke_session,
)
from app.systems.access.identity.service import (
    revoke_user_sessions as revoke_user_sessions,
)
from app.systems.access.users.acceptance import (
    append_invitation_acceptance_success,
    begin_invitation_acceptance,
    record_invitation_acceptance_failure,
)
from app.systems.access.users.account_operations import router as account_operations_router
from app.systems.access.users.coordination import InvitationConflict, InvitationError
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.access.users.permissions import effective_permissions
from app.systems.access.users.roles_router import router as roles_router
from app.systems.access.users.router import router as users_router
from app.systems.access.users.schemas import (
    AuthMeResponse,
    InvitationCreate,
    InvitationResendRequest,
    InvitationResponse,
    UserResponse,
)
from app.systems.access.users.service import (
    create_invitation,
    resend_invitation_delivery,
)
from app.systems.platform.notifications.outbox import delivery_status, smtp_delivery_enabled

auth_router = APIRouter(prefix="/auth", tags=["auth"])
router = APIRouter()


def _require_browser_origin(request: Request) -> None:
    if not browser_origin_is_permitted(get_settings(), request.headers.get("origin")):
        raise HTTPException(status_code=403, detail="Invalid request origin")


def _anonymous_rate_limits_enabled() -> bool:
    return not is_relaxed_development(get_settings())


def _require_refresh_csrf(request: Request) -> str:
    _require_browser_origin(request)
    csrf_token = request.headers.get("X-CSRF-Token", "")
    if not csrf_token:
        raise HTTPException(status_code=401, detail="Invalid authentication credentials")
    return csrf_token


@auth_router.post("/login")
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, bool]:
    _require_browser_origin(request)
    try:
        user = authenticate_password(
            db,
            payload.identifier,
            payload.password,
            source=_source(request),
            enforce_rate_limit=_anonymous_rate_limits_enabled(),
        )
        issued = issue_session(db, user, user_agent=request.headers.get("user-agent"))
        db.commit()
    except IdentityRateLimited as error:
        db.rollback()
        raise HTTPException(
            status_code=429,
            detail="Invalid authentication credentials",
            headers={"Retry-After": "900"},
        ) from error
    except InvalidCredentials as error:
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid authentication credentials") from error
    _set_browser_session(response, issued.access_token, issued.refresh_token, issued.csrf_token)
    return {"authenticated": True, "setup_required": issued.setup_only}


@auth_router.post("/refresh", response_model=None)
def refresh(
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, bool] | Response:
    _reject_mixed_credentials(request)
    raw_refresh = request.cookies.get("openslate_refresh")
    if raw_refresh is None:
        raise HTTPException(status_code=401, detail="Invalid authentication credentials")
    csrf_token = _require_refresh_csrf(request)
    try:
        issued = refresh_session(db, raw_refresh, csrf_token=csrf_token)
        db.commit()
    except RefreshReplayDetected:
        db.commit()
        return _cleared_auth_error()
    except InvalidCredentials:
        db.commit()
        return _cleared_auth_error()
    _set_browser_session(response, issued.access_token, issued.refresh_token, issued.csrf_token)
    return {"authenticated": True, "setup_required": issued.setup_only}


@auth_router.post("/token", response_model=TokenResponse)
def issue_bearer_token(
    payload: LoginRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> TokenResponse:
    _reject_mixed_credentials(request)
    try:
        user = authenticate_password(
            db,
            payload.identifier,
            payload.password,
            source=_source(request),
            enforce_rate_limit=_anonymous_rate_limits_enabled(),
        )
        issued = issue_session(db, user, user_agent=request.headers.get("user-agent"))
        if issued.setup_only:
            db.rollback()
            raise HTTPException(status_code=403, detail="Password setup required")
        db.commit()
    except IdentityRateLimited as error:
        db.rollback()
        raise HTTPException(status_code=401, detail="Invalid authentication credentials") from error
    except InvalidCredentials as error:
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid authentication credentials") from error
    return TokenResponse(access_token=issued.access_token, refresh_token=issued.refresh_token)


@auth_router.post("/token/refresh", response_model=TokenResponse)
def refresh_bearer_token(
    payload: RefreshTokenRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> TokenResponse:
    _reject_mixed_credentials(request)
    try:
        issued = refresh_session(db, payload.refresh_token)
        db.commit()
    except RefreshReplayDetected as error:
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid authentication credentials") from error
    except InvalidCredentials as error:
        db.commit()
        raise HTTPException(status_code=401, detail="Invalid authentication credentials") from error
    return TokenResponse(access_token=issued.access_token, refresh_token=issued.refresh_token)


@auth_router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _reject_mixed_credentials(request)
    if request.cookies.get("openslate_access") or request.cookies.get("openslate_refresh"):
        _require_browser_origin(request)
    try:
        identity = get_current_identity(request, _bearer_credentials(request), db)
        revoke_session(db, identity.session_id, identity.user.id)
    except HTTPException:
        raw_refresh = request.cookies.get("openslate_refresh")
        if raw_refresh is not None:
            csrf_token = _require_refresh_csrf(request)
            if not revoke_refresh_session(db, raw_refresh, csrf_token=csrf_token):
                db.rollback()
                _clear_browser_session(response)
                raise HTTPException(
                    status_code=401, detail="Invalid authentication credentials"
                ) from None
    db.commit()
    _clear_browser_session(response)
    return response


@auth_router.post(
    "/invitations", response_model=InvitationResponse, status_code=status.HTTP_201_CREATED
)
def invite(
    payload: InvitationCreate,
    admin: Annotated[User, Depends(require_roles(UserRole.ADMIN))],
    db: Annotated[Session, Depends(get_db)],
) -> InvitationResponse:
    try:
        issued = create_invitation(db, payload, actor_id=admin.id)
    except InvitationConflict as error:
        raise HTTPException(
            status_code=409, detail="Email or username is already in use"
        ) from error
    except InvitationError as error:
        raise HTTPException(status_code=409, detail="Unable to create invitation") from error
    return InvitationResponse(
        user=UserResponse.model_validate(issued.user),
        delivery=issued.delivery,
        temporary_password=issued.temporary_password,
    )


@auth_router.post("/invitations/{user_id}/resend", response_model=InvitationResponse)
def resend_invite(
    user_id: UUID,
    payload: InvitationResendRequest,
    admin: Annotated[User, Depends(require_roles(UserRole.ADMIN))],
    db: Annotated[Session, Depends(get_db)],
) -> InvitationResponse:
    try:
        issued = resend_invitation_delivery(
            db,
            user_id,
            actor_id=admin.id,
            delivery=payload.delivery,
            temporary_password=payload.temporary_password,
        )
    except InvitationError as error:
        raise HTTPException(status_code=409, detail="Unable to resend invitation") from error
    return InvitationResponse(
        user=UserResponse.model_validate(issued.user),
        delivery=issued.delivery,
        temporary_password=issued.temporary_password,
    )


@auth_router.get("/me", response_model=AuthMeResponse)
def me(user: Annotated[User, Depends(get_current_user)]) -> AuthMeResponse:
    return AuthMeResponse.model_validate(
        {
            **UserResponse.model_validate(user).model_dump(),
            "role": user.role.role,
            "permissions": effective_permissions(user.role),
        }
    )


@auth_router.get("/session")
def session_status(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, object]:
    try:
        identity = get_current_identity(request, None, db)
    except HTTPException:
        return {"authenticated": False}
    return {
        "authenticated": True,
        "user_id": identity.user.id,
        "setup_required": identity.setup_only,
    }


@auth_router.get("/delivery-status")
def smtp_delivery_status(
    _: Annotated[User, Depends(require_roles(UserRole.ADMIN))],
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, object]:
    status_value = delivery_status(db)
    return {
        "enabled": status_value.enabled,
        "running": request.app.state.smtp_outbox_worker.running,
        "state_counts": status_value.state_counts,
    }


@auth_router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_one_session(
    session_id: UUID,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    identity = _require_completed_identity(identity)
    revoke_session(db, session_id, identity.user.id)
    db.commit()
    response.status_code = status.HTTP_204_NO_CONTENT
    if session_id == identity.session_id:
        _clear_browser_session(response)
    return response


@auth_router.post("/sessions/revoke-others", status_code=status.HTTP_204_NO_CONTENT)
def revoke_other_sessions(
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    identity = _require_completed_identity(identity)
    revoke_user_sessions(db, identity.user.id, except_session_id=identity.session_id)
    db.commit()
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@auth_router.post("/password/change")
def change_password(
    payload: PasswordChangeRequest,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, bool]:
    timestamp = utc_now()
    try:
        authenticated = authenticate_password(
            db,
            identity.user.email,
            payload.current_password,
            source=_source(request),
            now=timestamp,
        )
        if authenticated.id != identity.user.id:
            raise InvalidCredentials("Invalid credentials")
        replace_password(db, identity.user, payload.password, now=timestamp)
        issued = issue_session(db, identity.user, now=timestamp)
        db.commit()
    except IdentityRateLimited as error:
        db.rollback()
        raise HTTPException(status_code=429, detail="Password cannot be changed") from error
    except InvalidCredentials as error:
        db.commit()
        raise HTTPException(status_code=403, detail="Password cannot be changed") from error
    except ValueError as error:
        db.rollback()
        raise HTTPException(status_code=403, detail="Password cannot be changed") from error
    _set_browser_session(response, issued.access_token, issued.refresh_token, issued.csrf_token)
    return {"authenticated": True, "setup_required": issued.setup_only}


@auth_router.post("/recovery/request", status_code=status.HTTP_204_NO_CONTENT)
def request_recovery(
    payload: RecoveryRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    _require_browser_origin(request)
    identifier = payload.identifier.strip().lower()
    user = db.scalar(select(User).where(or_(User.email == identifier, User.username == identifier)))
    if (
        smtp_delivery_enabled()
        and recovery_request_permitted(
            db,
            identifier,
            source=_source(request),
            enforce_rate_limit=_anonymous_rate_limits_enabled(),
        )
        and user is not None
        and eligibility.is_identity_eligible(user)
        and user.status == UserStatus.ACTIVE.value
    ):
        recovery.queue_recovery_delivery(db, user.id)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@auth_router.post("/recovery/complete", status_code=status.HTTP_204_NO_CONTENT)
def complete_recovery(
    payload: ActionTokenCompleteRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    _require_browser_origin(request)
    try:
        action = consume_action_token(db, payload.token, ActionTokenPurpose.RECOVERY)
        user = db.get(User, action.user_id, with_for_update=True)
        if user is None or user.is_deleted or user.status != UserStatus.ACTIVE.value:
            raise ActionTokenInvalid("Token is invalid")
        replace_password(db, user, payload.password)
        db.commit()
    except (ActionTokenInvalid, ValueError) as error:
        db.rollback()
        raise HTTPException(status_code=400, detail="Recovery token is invalid") from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@auth_router.post("/invitations/complete", status_code=status.HTTP_204_NO_CONTENT)
def complete_invitation(
    payload: ActionTokenCompleteRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    _require_browser_origin(request)
    try:
        permitted = invitation_completion_permitted(
            db,
            source=_source(request),
            enforce_rate_limit=_anonymous_rate_limits_enabled(),
        )
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=503, detail="Invitation completion is unavailable"
        ) from error
    if not permitted:
        raise HTTPException(
            status_code=429,
            detail="Invitation completion is unavailable",
            headers={"Retry-After": "900"},
        )
    operation_id = begin_invitation_acceptance(None)
    user_id: UUID | None = None
    try:
        action = consume_action_token(db, payload.token, ActionTokenPurpose.INVITATION)
        user_id = action.user_id
        user = db.get(User, action.user_id, with_for_update=True)
        if user is None or user.is_deleted or user.status != UserStatus.PENDING.value:
            raise ActionTokenInvalid("Token is invalid")
        replace_password(db, user, payload.password)
        user.status = UserStatus.ACTIVE.value
        user.invitation_accepted_at = utc_now()
        append_invitation_acceptance_success(db, operation_id, user.id)
        db.commit()
    except (ActionTokenInvalid, ValueError) as error:
        db.rollback()
        record_invitation_acceptance_failure(operation_id, user_id, "invitation token is invalid")
        raise HTTPException(status_code=400, detail="Invitation token is invalid") from error
    except SQLAlchemyError as error:
        db.rollback()
        record_invitation_acceptance_failure(
            operation_id, user_id, "unable to finalize invitation acceptance"
        )
        raise HTTPException(
            status_code=503, detail="Invitation completion is unavailable"
        ) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


router.include_router(auth_router)
router.include_router(users_router)
router.include_router(account_operations_router)
router.include_router(roles_router)
