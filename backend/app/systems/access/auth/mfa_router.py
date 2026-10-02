"""Authenticated TOTP enrollment, completion and cancellation routes."""

from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import CurrentIdentity, get_mfa_identity
from app.core.database import get_db
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    InvalidProviderToken,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.auth.cookies import clear_browser_session, set_browser_access
from app.systems.access.auth.request_security import bearer_credentials
from app.systems.access.identity import mfa
from app.systems.access.identity.contracts import InvalidCredentials

router = APIRouter(prefix="/auth/mfa", tags=["auth"])


class FactorResponse(BaseModel):
    id: UUID
    factor_type: str
    status: Literal["unverified", "verified"]


class MfaStatus(BaseModel):
    user_id: UUID
    assurance_level: Literal["aal1", "aal2"]
    required: bool
    factors: list[FactorResponse]


class EnrollRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    friendly_name: str | None = None


class TotpResponse(BaseModel):
    qr_code: str = Field(repr=False)
    secret: str = Field(repr=False)
    uri: str = Field(repr=False)


class EnrollResponse(BaseModel):
    id: UUID
    totp: TotpResponse


class VerifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9]{6}$", repr=False)


class VerifyResponse(BaseModel):
    verified: Literal[True] = True
    access_token: str | None = Field(default=None, repr=False)


_ERRORS: tuple[type[Exception], ...] = (
    mfa.MFARequired,
    mfa.MFAFactorUnavailable,
    InvalidCredentials,
    InvalidProviderToken,
    InvalidProviderCredentials,
    SupabaseAuthUnavailable,
    SQLAlchemyError,
)


def _error(error: Exception, *, verification: bool = False) -> HTTPException:
    if isinstance(error, mfa.MFARequired):
        return HTTPException(
            status_code=403,
            detail={
                "code": "mfa_required",
                "message": "Complete multi-factor authentication to continue",
            },
        )
    if isinstance(error, mfa.MFAFactorUnavailable):
        return HTTPException(status_code=404, detail="MFA factor is unavailable")
    if isinstance(error, (InvalidCredentials, InvalidProviderToken)):
        return HTTPException(status_code=401, detail="Invalid authentication credentials")
    if isinstance(error, InvalidProviderCredentials):
        if verification:
            return HTTPException(
                status_code=400,
                detail={
                    "code": "mfa_verification_failed",
                    "message": "Verification code was not accepted",
                },
            )
        return HTTPException(status_code=403, detail="MFA action is not permitted")
    return HTTPException(status_code=503, detail="MFA service unavailable")


def _access(request: Request, identity: CurrentIdentity) -> str:
    bearer = bearer_credentials(request)
    token = (
        request.cookies.get("openslate_access")
        if identity.cookie_authenticated
        else bearer.credentials
        if bearer
        else None
    )
    if token is None:
        raise InvalidCredentials("Invalid credentials")
    return token


@router.get("", response_model=MfaStatus)
def status(
    request: Request,
    response: Response,
    identity: Annotated[CurrentIdentity, Depends(get_mfa_identity)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, object]:
    response.headers["Cache-Control"] = "no-store"
    try:
        return mfa.mfa_status(
            db, identity.user, _access(request, identity), get_supabase_auth_client()
        )
    except _ERRORS as error:
        db.rollback()
        raise _error(error) from error


@router.post("/factors", response_model=EnrollResponse, status_code=201)
def enroll(
    payload: EnrollRequest,
    request: Request,
    response: Response,
    identity: Annotated[CurrentIdentity, Depends(get_mfa_identity)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, object]:
    response.headers["Cache-Control"] = "no-store"
    try:
        result = mfa.enroll_factor(
            db,
            identity.user.id,
            identity.session_id,
            _access(request, identity),
            get_supabase_auth_client(),
            friendly_name=payload.friendly_name,
        )
    except _ERRORS as error:
        db.rollback()
        raise _error(error) from error
    return {
        "id": result.id,
        "totp": {"qr_code": result.qr_code, "secret": result.secret, "uri": result.uri},
    }


@router.post("/factors/{factor_id}/verification", response_model=VerifyResponse)
def verify(
    factor_id: UUID,
    payload: VerifyRequest,
    request: Request,
    response: Response,
    identity: Annotated[CurrentIdentity, Depends(get_mfa_identity)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, object]:
    response.headers["Cache-Control"] = "no-store"
    try:
        access = mfa.verify_factor(
            db,
            identity.user.id,
            identity.session_id,
            factor_id,
            payload.code,
            _access(request, identity),
            get_supabase_auth_client(),
        )
    except _ERRORS as error:
        db.rollback()
        raise _error(error, verification=True) from error
    if identity.cookie_authenticated:
        set_browser_access(response, access)
    return {"verified": True, "access_token": None if identity.cookie_authenticated else access}


@router.delete("/factors/{factor_id}", status_code=204)
def unenroll(
    factor_id: UUID,
    request: Request,
    identity: Annotated[CurrentIdentity, Depends(get_mfa_identity)],
    db: Annotated[Session, Depends(get_db)],
    unverified_only: bool = False,
) -> Response:
    response = Response(status_code=204, headers={"Cache-Control": "no-store"})
    try:
        verified = mfa.unenroll_factor(
            db,
            identity.user.id,
            identity.session_id,
            factor_id,
            _access(request, identity),
            get_supabase_auth_client(),
            unverified_only=unverified_only,
        )
    except _ERRORS as error:
        db.rollback()
        raise _error(error) from error
    if verified and identity.cookie_authenticated:
        clear_browser_session(response)
    return response
