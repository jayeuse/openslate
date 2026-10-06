"""Audited administrator settings with stale-update and IP lockout protection."""

from ipaddress import ip_address
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies import get_current_user, require_fresh_exact_admin
from app.common.dependencies.auth import CurrentIdentity, get_current_identity
from app.core.base_model import utc_now
from app.core.database import get_db
from app.core.integrations.supabase_auth import (
    InvalidProviderToken,
    ProviderAccessIdentity,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.security_policy import (
    clamp_session_deadlines,
    effective_session_expiry,
    ip_allowed,
    load_workspace_policy,
    lock_policy_users,
    mfa_role_required,
    snapshot_deadlines,
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


def _factor_evidence(
    db: Session,
    actor: User,
    payload: WorkspaceSecurityUpdate,
    request: Request,
) -> ProviderAccessIdentity | None:
    profile = load_workspace_policy(db)
    if not all(
        getattr(payload, f"mfa_require_{role}")
        if f"mfa_require_{role}" in payload.model_fields_set
        else mfa_role_required(profile, role)
        for role in ("admin", "member", "guest")
    ):
        return None
    provider_id, email = actor.supabase_user_id, actor.email
    db.rollback()
    client = get_supabase_auth_client()
    token = (
        request.cookies.get("openslate_access")
        or request.headers.get("Authorization", "").partition(" ")[2]
    )
    claims = client.verify_access_token(token)
    if provider_id is None or claims.user_id != provider_id:
        raise HTTPException(401, detail="Invalid authentication credentials")
    observed = client.get_admin_user(provider_id)
    if observed.id != provider_id or observed.email != email or not observed.is_eligible():
        raise HTTPException(401, detail="Invalid authentication credentials")
    if not any(
        factor.factor_type == "totp" and factor.status == "verified" for factor in observed.factors
    ):
        raise HTTPException(
            409,
            detail={
                "code": "mfa_enrollment_required",
                "message": (
                    "Enroll and verify multi-factor authentication "
                    "before requiring it for every role."
                ),
            },
        )
    return claims


@router.patch("", response_model=WorkspaceSecurityResponse)
def update_workspace_security(
    payload: WorkspaceSecurityUpdate,
    request: Request,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    actor: SecurityActor,
    db: Database,
    response: Response,
) -> WorkspaceProfile:
    actor_id = actor.id
    actor = require_fresh_exact_admin(db, actor_id)
    try:
        claims = _factor_evidence(db, actor, payload, request)
        actor = require_fresh_exact_admin(db, actor_id)
        profile = db.scalar(
            select(WorkspaceProfile)
            .where(WorkspaceProfile.singleton_key.is_(True))
            .execution_options(populate_existing=True)
            .with_for_update()
        )
    except (SQLAlchemyError, SupabaseAuthUnavailable) as error:
        db.rollback()
        raise _unavailable() from error
    except InvalidProviderToken as error:
        db.rollback()
        raise HTTPException(401, detail="Invalid authentication credentials") from error
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
    old_roles = {role: mfa_role_required(profile, role) for role in ("admin", "member", "guest")}
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
    old_deadlines = snapshot_deadlines(profile)
    for field in changed:
        setattr(profile, field, getattr(payload, field))
    profile.revision += 1
    profile.performed_by = actor.id
    try:
        lock_policy_users(db, old_roles, profile, changed)
        try:
            session = db.scalar(
                select(IdentitySession)
                .where(IdentitySession.id == identity.session_id)
                .execution_options(populate_existing=True)
                .with_for_update(nowait=True)
            )
        except SQLAlchemyError as error:
            db.rollback()
            raise _unavailable() from error
        if (
            session is None
            or session.user_id != actor_id
            or session.revoked_at is not None
            or effective_session_expiry(session, old_deadlines) <= utc_now()
            or (
                claims is not None
                and (
                    claims.assurance_level != "aal2"
                    or claims.expires_at <= utc_now()
                    or session.provider_user_id != claims.user_id
                    or session.provider_session_id != claims.session_id
                    or actor.supabase_user_id != claims.user_id
                    or (
                        actor.tokens_valid_after is not None
                        and claims.issued_at < actor.tokens_valid_after
                    )
                )
            )
        ):
            db.rollback()
            raise HTTPException(401, detail="Invalid authentication credentials")
        if changed & {"session_timeout_minutes", "session_absolute_lifetime_minutes"}:
            clamp_session_deadlines(db, old_deadlines, profile)
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
