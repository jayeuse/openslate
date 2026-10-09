"""OpenSlate-local authentication and user administration routes."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import (
    CurrentIdentity,
    get_current_identity,
    get_current_user,
    require_admin,
)
from app.common.dependencies.auth import get_mfa_identity, require_allowed_source
from app.core.config import get_settings
from app.core.config.development import browser_origin_is_permitted
from app.core.database import get_db
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.auth.cookies import (
    clear_browser_session as _clear_browser_session,
)
from app.systems.access.auth.cookies import (
    cleared_auth_error as _cleared_auth_error,
)
from app.systems.access.auth.cookies import (
    set_browser_session as _set_browser_session,
)
from app.systems.access.auth.profile_router import router as profile_router
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
from app.systems.access.auth.template_router import router as template_router
from app.systems.access.identity import provider_actions
from app.systems.access.identity.contracts import (
    ActionTokenInvalid,
    IdentityRateLimited,
    InvalidCredentials,
)
from app.systems.access.identity.provider_actions import (
    anonymous_rate_limits_enabled as _anonymous_rate_limits_enabled,
)
from app.systems.access.identity.provider_login import login_with_provider
from app.systems.access.identity.provider_sessions import (
    refresh_provider_session,
    revoke_provider_refresh_session,
)
from app.systems.access.identity.provider_signout import attempt_provider_signout
from app.systems.access.identity.rate_limits import invitation_completion_permitted
from app.systems.access.identity.schemas import (
    ActionTokenCompleteRequest,
    LoginRequest,
    PasswordChangeRequest,
    RecoveryRequest,
    RefreshTokenRequest,
    TokenResponse,
)
from app.systems.access.identity.session_revocation import revoke_session
from app.systems.access.users.acceptance import (
    begin_invitation_acceptance,
    record_invitation_acceptance_failure,
)
from app.systems.access.users.account_operations import router as account_operations_router
from app.systems.access.users.coordination import InvitationConflict, InvitationError
from app.systems.access.users.models import User
from app.systems.access.users.profile import self_profile_response
from app.systems.access.users.router import router as users_router
from app.systems.access.users.schemas import (
    AuthMeResponse,
    InvitationCreate,
    InvitationResendRequest,
    InvitationResponse,
    UserResponse,
)
from app.systems.access.users.service import (
    invite_user,
    resend_invitation,
)
from app.systems.manage.audit.service import SecurityEventPersistenceError
from app.systems.manage.workspace.security_policy import PasswordPolicyViolation

auth_router = APIRouter(prefix="/auth", tags=["auth"])
router = APIRouter()


def _require_browser_origin(request: Request) -> None:
    if not browser_origin_is_permitted(get_settings(), request.headers.get("origin")):
        raise HTTPException(status_code=403, detail="Invalid request origin")


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
    require_allowed_source(request, db)
    try:
        issued = login_with_provider(
            db,
            payload.email,
            payload.password,
            get_supabase_auth_client(),
            source=_source(request),
            user_agent=request.headers.get("user-agent"),
            enforce_rate_limit=_anonymous_rate_limits_enabled(),
        )
        db.commit()
    except IdentityRateLimited as error:
        db.rollback()
        raise HTTPException(
            status_code=429,
            detail="Invalid authentication credentials",
            headers={"Retry-After": str(error.retry_after)},
        ) from error
    except InvalidCredentials as error:
        if not provider_actions.try_commit_login_denial(db):
            raise HTTPException(503, detail="Authentication service unavailable") from None
        raise HTTPException(status_code=401, detail="Invalid authentication credentials") from error
    except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Authentication service unavailable") from error
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
    require_allowed_source(request, db)
    try:
        issued = refresh_provider_session(
            db, raw_refresh, get_supabase_auth_client(), csrf_token=csrf_token
        )
    except InvalidCredentials:
        return _cleared_auth_error()
    except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Authentication service unavailable") from error
    _set_browser_session(response, issued.access_token, issued.refresh_token, issued.csrf_token)
    return {"authenticated": True, "setup_required": issued.setup_only}


@auth_router.post("/token", response_model=TokenResponse)
def issue_bearer_token(
    payload: LoginRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> TokenResponse:
    _reject_mixed_credentials(request)
    require_allowed_source(request, db)
    try:
        issued = login_with_provider(
            db,
            payload.email,
            payload.password,
            get_supabase_auth_client(),
            source=_source(request),
            user_agent=request.headers.get("user-agent"),
            enforce_rate_limit=_anonymous_rate_limits_enabled(),
        )
        db.commit()
    except IdentityRateLimited as error:
        db.rollback()
        raise HTTPException(
            status_code=429,
            detail="Invalid authentication credentials",
            headers={"Retry-After": str(error.retry_after)},
        ) from error
    except InvalidCredentials as error:
        if not provider_actions.try_commit_login_denial(db):
            raise HTTPException(503, detail="Authentication service unavailable") from None
        raise HTTPException(status_code=401, detail="Invalid authentication credentials") from error
    except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Authentication service unavailable") from error
    return TokenResponse(access_token=issued.access_token, refresh_token=issued.refresh_token)


@auth_router.post("/token/refresh", response_model=TokenResponse)
def refresh_bearer_token(
    payload: RefreshTokenRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> TokenResponse:
    _reject_mixed_credentials(request)
    require_allowed_source(request, db)
    try:
        issued = refresh_provider_session(db, payload.refresh_token, get_supabase_auth_client())
    except InvalidCredentials as error:
        raise HTTPException(status_code=401, detail="Invalid authentication credentials") from error
    except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Authentication service unavailable") from error
    return TokenResponse(access_token=issued.access_token, refresh_token=issued.refresh_token)


@auth_router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    _reject_mixed_credentials(request)
    require_allowed_source(request, db)
    if request.cookies.get("openslate_access") or request.cookies.get("openslate_refresh"):
        _require_browser_origin(request)
    session_id: UUID | None = None
    raw_refresh = request.cookies.get("openslate_refresh")
    if raw_refresh is not None:
        csrf_token = _require_refresh_csrf(request)
        session_id = revoke_provider_refresh_session(db, raw_refresh, csrf_token=csrf_token)
        if session_id is None:
            db.rollback()
            _clear_browser_session(response)
            raise HTTPException(status_code=401, detail="Invalid authentication credentials")
    else:
        try:
            identity = get_mfa_identity(request, _bearer_credentials(request), db)
            if revoke_session(db, identity.session_id, identity.user.id):
                session_id = identity.session_id
        except HTTPException as error:
            if error.status_code != 401:
                raise
    db.commit()
    if session_id is not None:
        try:
            attempt_provider_signout(db, session_id, get_supabase_auth_client())
        except SQLAlchemyError:
            db.rollback()
    _clear_browser_session(response)
    return response


@auth_router.post(
    "/invitations", response_model=InvitationResponse, status_code=status.HTTP_201_CREATED
)
def invite(
    payload: InvitationCreate,
    admin: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> InvitationResponse:
    try:
        user = invite_user(db, payload, actor_id=admin.id)
    except InvitationConflict as error:
        raise HTTPException(
            status_code=409, detail="Email or username is already in use"
        ) from error
    except InvitationError as error:
        raise HTTPException(status_code=409, detail="Unable to create invitation") from error
    return InvitationResponse(user=UserResponse.model_validate(user), delivery="email")


@auth_router.post("/invitations/{user_id}/resend", response_model=InvitationResponse)
def resend_invite(
    user_id: UUID,
    payload: InvitationResendRequest,
    admin: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_db)],
) -> InvitationResponse:
    try:
        user = resend_invitation(db, user_id, actor_id=admin.id)
    except InvitationError as error:
        raise HTTPException(status_code=409, detail="Unable to resend invitation") from error
    return InvitationResponse(
        user=UserResponse.model_validate(user),
        delivery="email",
    )


@auth_router.get("/me", response_model=AuthMeResponse)
def me(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> AuthMeResponse:
    return self_profile_response(db, user)


@auth_router.get("/session")
def session_status(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, object]:
    try:
        identity = get_current_identity(request, None, db)
    except HTTPException as error:
        if error.status_code != 401:
            raise
        return {"authenticated": False}
    return {
        "authenticated": True,
        "user_id": identity.user.id,
        "setup_required": identity.setup_only,
    }


@auth_router.post("/password/change")
def change_password(
    payload: PasswordChangeRequest,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, bool]:
    identity = _require_completed_identity(identity)
    bearer = _bearer_credentials(request)
    access_token = (
        request.cookies.get("openslate_access")
        if identity.cookie_authenticated
        else bearer.credentials
        if bearer is not None
        else None
    )
    if access_token is None:
        raise HTTPException(status_code=401, detail="Invalid authentication credentials")
    try:
        provider_actions.change_password(
            db,
            identity.user,
            identity.session_id,
            access_token,
            payload.current_password,
            payload.password,
            get_supabase_auth_client(),
            source=_source(request),
        )
    except PasswordPolicyViolation as error:
        db.rollback()
        raise HTTPException(
            status_code=422,
            detail={
                "code": "password_policy_violation",
                "message": str(error),
            },
        ) from error
    except (InvalidCredentials, InvalidProviderCredentials) as error:
        db.rollback()
        raise HTTPException(status_code=403, detail="Password cannot be changed") from error
    except IdentityRateLimited as error:
        db.rollback()
        raise HTTPException(status_code=429, detail="Password cannot be changed") from error
    except (SupabaseAuthUnavailable, SQLAlchemyError, SecurityEventPersistenceError) as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Password service unavailable") from error
    return {"authenticated": True, "setup_required": False}


@auth_router.post("/recovery/request", status_code=status.HTTP_204_NO_CONTENT)
def request_recovery(
    payload: RecoveryRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    _require_browser_origin(request)
    require_allowed_source(request, db)
    try:
        provider_actions.request_recovery(
            db,
            payload.email,
            get_supabase_auth_client(),
            source=_source(request),
            enforce_rate_limit=_anonymous_rate_limits_enabled(),
        )
    except (SupabaseAuthUnavailable, SQLAlchemyError, SecurityEventPersistenceError) as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Recovery service unavailable") from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@auth_router.post("/recovery/complete", status_code=status.HTTP_204_NO_CONTENT)
def complete_recovery(
    payload: ActionTokenCompleteRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    _require_browser_origin(request)
    require_allowed_source(request, db)
    try:
        provider_actions.complete_recovery(
            db,
            payload.token_hash,
            payload.password,
            get_supabase_auth_client(),
            source=_source(request),
        )
    except PasswordPolicyViolation as error:
        db.rollback()
        raise HTTPException(
            status_code=422,
            detail={
                "code": "password_policy_violation",
                "message": str(error),
            },
        ) from error
    except (ActionTokenInvalid, InvalidProviderCredentials) as error:
        db.rollback()
        raise HTTPException(status_code=400, detail="Recovery token is invalid") from error
    except (SupabaseAuthUnavailable, SQLAlchemyError, SecurityEventPersistenceError) as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Recovery service unavailable") from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@auth_router.post("/invitations/complete", status_code=status.HTTP_204_NO_CONTENT)
def complete_invitation(
    payload: ActionTokenCompleteRequest,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    _require_browser_origin(request)
    require_allowed_source(request, db)
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
    try:
        provider_actions.complete_invitation(
            db, payload.token_hash, payload.password, get_supabase_auth_client()
        )
    except PasswordPolicyViolation as error:
        db.rollback()
        raise HTTPException(
            status_code=422,
            detail={
                "code": "password_policy_violation",
                "message": str(error),
            },
        ) from error
    except (InvitationError, InvalidProviderCredentials) as error:
        db.rollback()
        operation_id = begin_invitation_acceptance(None)
        record_invitation_acceptance_failure(operation_id, None, "invitation token is invalid")
        raise HTTPException(status_code=400, detail="Invitation token is invalid") from error
    except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
        db.rollback()
        raise HTTPException(
            status_code=503, detail="Invitation completion is unavailable"
        ) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


router.include_router(auth_router)
router.include_router(profile_router)
router.include_router(template_router)
router.include_router(users_router)
router.include_router(account_operations_router)
