"""Authenticated self profile; current identity owns every accepted field."""

from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.common.dependencies.auth import (
    AccountOrganization,
    CurrentIdentity,
    get_account_identity,
    get_account_organization,
)
from app.core.database import get_db
from app.systems.access.users.profile import update_self_profile
from app.systems.access.users.schemas import AuthMeResponse, SelfProfileUpdate
from app.systems.platform.files.providers import StorageBackend
from app.systems.platform.files.storage import get_storage

router = APIRouter(prefix="/auth/me", tags=["auth"])


@router.patch("/profile", response_model=AuthMeResponse)
def update_profile(
    payload: SelfProfileUpdate,
    identity: Annotated[CurrentIdentity, Depends(get_account_identity)],
    db: Annotated[Session, Depends(get_db)],
    storage: Annotated[StorageBackend, Depends(get_storage)],
    response: Response,
    organization: Annotated[AccountOrganization, Depends(get_account_organization)],
) -> AuthMeResponse:
    response.headers["Cache-Control"] = "private, no-store"
    return update_self_profile(db, identity, payload, storage, organization.membership,
                               organization.default_organization_blocked)
