"""Same-origin secure email-change request and explicit signed-out confirmation."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import (
    CurrentIdentity,
    get_account_identity,
    require_allowed_source,
)
from app.core.database import get_db
from app.core.integrations import supabase_auth
from app.systems.access.auth.cookies import set_browser_session
from app.systems.access.auth.request_security import (
    require_browser_origin,
    require_completed_identity,
    source,
)
from app.systems.access.identity import email_changes, provider_actions, rate_limits
from app.systems.access.identity.contracts import (
    ActionTokenInvalid,
    IdentityRateLimited,
    InvalidCredentials,
)
from app.systems.access.identity.mfa import MFARequired
from app.systems.access.identity.schemas import EmailChangeCompleteRequest, EmailChangeRequest
from app.systems.manage.audit.service import SecurityEventPersistenceError

router = APIRouter(prefix="/auth", tags=["auth"])


def _incomplete(error: email_changes.EmailChangeIncomplete) -> HTTPException:
    return HTTPException(
        503 if error.unavailable else 409,
        detail={
            "code": "email_change_incomplete",
            "message": (
                "Email confirmation may have completed at the provider, but application completion "
                "is incomplete. Sign in again after any address conflict is resolved."
            ),
        },
    )


@router.post("/me/email")
def request_email_change(
    payload: EmailChangeRequest,
    request: Request,
    identity: Annotated[CurrentIdentity, Depends(get_account_identity)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, bool]:
    require_completed_identity(identity)
    token = (
        request.cookies.get("openslate_access")
        if identity.cookie_authenticated
        else request.headers.get("authorization", "").partition(" ")[2]
    )
    if not token:
        raise HTTPException(401, detail="Invalid authentication credentials")
    try:
        email_changes.request_email_change(
            db,
            identity.user.id,
            identity.session_id,
            token,
            payload.email,
            payload.current_password,
            supabase_auth.get_supabase_auth_client(),
            source=source(request),
            enforce_rate_limit=provider_actions.anonymous_rate_limits_enabled(),
        )
    except email_changes.EmailChangeConflict as error:
        db.rollback()
        raise HTTPException(409, detail="Email address is unavailable") from error
    except email_changes.EmailChangeIncomplete as error:
        raise _incomplete(error) from error
    except IdentityRateLimited as error:
        db.rollback()
        raise HTTPException(
            429, detail="Too many attempts", headers={"Retry-After": str(error.retry_after)}
        ) from error
    except InvalidCredentials as error:
        db.rollback()
        raise HTTPException(401, detail="Invalid authentication credentials") from error
    except MFARequired as error:
        db.rollback()
        raise HTTPException(
            403,
            detail={
                "code": "mfa_required",
                "message": "Complete multi-factor authentication to continue",
            },
        ) from error
    except (
        supabase_auth.SupabaseAuthUnavailable,
        SQLAlchemyError,
        SecurityEventPersistenceError,
    ) as error:
        db.rollback()
        raise HTTPException(503, detail="Email change service unavailable") from error
    return {"confirmation_required": True}


@router.post("/email/complete")
def complete_email_change(
    payload: EmailChangeCompleteRequest,
    request: Request,
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, bool]:
    # Presence, including an empty credential, is ambiguous and must precede hash consumption.
    if "authorization" in request.headers or any(
        name in request.cookies for name in ("openslate_access", "openslate_refresh")
    ):
        raise HTTPException(
            409,
            detail={
                "code": "signed_out_required",
                "message": "Sign out explicitly before confirming this email change.",
            },
        )
    require_browser_origin(request)
    require_allowed_source(request, db)
    try:
        if not rate_limits.invitation_completion_permitted(
            db,
            source=source(request),
            enforce_rate_limit=provider_actions.anonymous_rate_limits_enabled(),
        ):
            db.commit()
            raise HTTPException(429, detail="Too many attempts")
        if provider_actions.anonymous_rate_limits_enabled():
            db.commit()
        issued = email_changes.complete_email_change(
            db,
            payload.token_hash,
            supabase_auth.get_supabase_auth_client(),
            source=source(request),
            user_agent=request.headers.get("user-agent"),
        )
    except email_changes.EmailChangeIncomplete as error:
        raise _incomplete(error) from error
    except ActionTokenInvalid as error:
        db.rollback()
        raise HTTPException(400, detail="Email confirmation is invalid") from error
    except (
        supabase_auth.SupabaseAuthUnavailable,
        SQLAlchemyError,
        SecurityEventPersistenceError,
    ) as error:
        db.rollback()
        raise HTTPException(503, detail="Email confirmation service unavailable") from error
    if issued is None:
        return {"authenticated": False, "confirmation_required": True}
    set_browser_session(response, issued.access_token, issued.refresh_token, issued.csrf_token)
    return {
        "authenticated": True,
        "confirmation_required": False,
        "setup_required": issued.setup_only,
    }
