"""Audited administrator settings with stale-update and IP lockout protection."""

from ipaddress import ip_address
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user, require_fresh_exact_admin
from app.core.database import get_db
from app.core.integrations.supabase_auth import SupabaseAuthUnavailable
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.security_policy import (
    ip_allowed,
    load_workspace_policy,
)
from app.systems.manage.workspace.security_schemas import (
    WorkspaceCallerIpResponse,
    WorkspaceSecurityResponse,
    WorkspaceSecurityUpdate,
)

router = APIRouter(prefix="/workspace/security", tags=["workspace"])
SecurityActor = Annotated[User, Depends(get_current_user)]
Database = Annotated[Session, Depends(get_db)]


def _unavailable() -> HTTPException:
    return HTTPException(
        503,
        detail={
            "code": "workspace_unavailable",
            "message": "Workspace configuration is unavailable",
        },
    )


@router.get("", response_model=WorkspaceSecurityResponse)
def get_workspace_security(
    actor: SecurityActor, db: Database, response: Response
) -> WorkspaceProfile:
    require_fresh_exact_admin(db, actor.id)
    response.headers["Cache-Control"] = "no-store"
    try:
        return load_workspace_policy(db)
    except SupabaseAuthUnavailable as error:
        db.rollback()
        raise _unavailable() from error


@router.patch("", response_model=WorkspaceSecurityResponse)
def update_workspace_security(
    payload: WorkspaceSecurityUpdate,
    request: Request,
    actor: SecurityActor,
    db: Database,
    response: Response,
) -> WorkspaceProfile:
    require_fresh_exact_admin(db, actor.id)
    try:
        profile = db.scalar(
            select(WorkspaceProfile)
            .where(WorkspaceProfile.singleton_key.is_(True))
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise _unavailable() from error
    if not isinstance(profile, WorkspaceProfile):
        db.rollback()
        raise _unavailable()
    if payload.revision != profile.revision:
        db.rollback()
        raise HTTPException(
            409,
            detail={
                "code": "stale_revision",
                "message": "Workspace configuration has changed",
            },
        )
    changed = payload.model_fields_set - {"revision"}
    if "ip_allow_list" in changed:
        candidate = WorkspaceProfile(ip_allow_list=payload.ip_allow_list)
        source = request.client.host if request.client is not None else None
        if not ip_allowed(candidate, source):
            db.rollback()
            raise HTTPException(
                409,
                detail={
                    "code": "ip_lockout",
                    "message": "Allow list must permit your current address",
                },
            )
    for field in changed:
        setattr(profile, field, getattr(payload, field))
    profile.revision += 1
    profile.performed_by = actor.id
    try:
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise _unavailable() from error
    response.headers["Cache-Control"] = "no-store"
    return profile


@router.get("/caller-ip", response_model=WorkspaceCallerIpResponse)
def get_workspace_caller_ip(
    request: Request, actor: SecurityActor, db: Database, response: Response
) -> WorkspaceCallerIpResponse:
    require_fresh_exact_admin(db, actor.id)
    try:
        if request.client is None:
            raise ValueError("Missing peer")
        address = ip_address(request.client.host)
    except ValueError as error:
        raise HTTPException(
            503,
            detail={
                "code": "caller_address_unavailable",
                "message": "Your current address is unavailable. Add an address manually.",
            },
            headers={"Cache-Control": "no-store"},
        ) from error
    response.headers["Cache-Control"] = "no-store"
    return WorkspaceCallerIpResponse(address=address)
