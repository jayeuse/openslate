"""Small request-level credential helpers for local identity routes."""

from fastapi import HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials

from app.common.dependencies import CurrentIdentity


def source(request: Request) -> str | None:
    return request.client.host if request.client is not None else None


def reject_mixed_credentials(request: Request) -> None:
    if request.headers.get("authorization") and (
        request.cookies.get("openslate_access") or request.cookies.get("openslate_refresh")
    ):
        raise HTTPException(status_code=401, detail="Invalid authentication credentials")


def bearer_credentials(request: Request) -> HTTPAuthorizationCredentials | None:
    scheme, _, credentials = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not credentials:
        return None
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=credentials)


def require_completed_identity(identity: CurrentIdentity) -> CurrentIdentity:
    if identity.setup_only:
        raise HTTPException(status_code=401, detail="Invalid authentication credentials")
    return identity
