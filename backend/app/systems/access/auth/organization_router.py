"""Account self-read and explicit organization selection on a global session."""

from datetime import timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.common.dependencies.auth import (
    AccountOrganization,
    CurrentIdentity,
    get_account_identity,
    get_account_organization,
    get_account_user,
    resolve_membership,
)
from app.core.base_model import utc_now
from app.core.database import get_db
from app.core.integrations.supabase_auth import SupabaseAuthUnavailable
from app.systems.access.identity.models import IdentitySession
from app.systems.access.policy.checks import require_live_session
from app.systems.access.users.eligibility import is_active_account
from app.systems.access.users.models import Membership, User
from app.systems.access.users.profile import self_profile_response
from app.systems.access.users.schemas import (
    AuthenticatedSessionResponse,
    AuthMeResponse,
    OrganizationSelectionRequest,
    UnauthenticatedSessionResponse,
)
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.security_policy import mfa_role_required

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get(
    "/session", response_model=AuthenticatedSessionResponse | UnauthenticatedSessionResponse
)
def session_status(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    x_org: Annotated[UUID | None, Header()] = None,
) -> dict[str, object]:
    try:
        identity = get_account_identity(request, None, db)
        organization = get_account_organization(request, identity, db, x_org)
    except HTTPException as error:
        if error.status_code != 401:
            raise
        return {"authenticated": False}
    return {
        "authenticated": True,
        "user_id": identity.user.id,
        "setup_required": identity.setup_only,
        "default_organization_blocked": organization.default_organization_blocked,
        "organization_id": (
            organization.membership.org_id if organization.membership is not None else None
        ),
    }


@router.get("/me", response_model=AuthMeResponse)
def me(
    user: Annotated[User, Depends(get_account_user)],
    organization: Annotated[AccountOrganization, Depends(get_account_organization)],
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> AuthMeResponse:
    response.headers["Cache-Control"] = "private, no-store"
    return self_profile_response(db, user, organization.membership,
                                 organization.default_organization_blocked)


@router.post("/session/organization", response_model=AuthMeResponse)
def select_organization(
    payload: OrganizationSelectionRequest,
    identity: Annotated[CurrentIdentity, Depends(get_account_identity)],
    db: Annotated[Session, Depends(get_db)],
    request: Request,
    response: Response,
) -> AuthMeResponse:
    try:
        # Match authority writers: account, membership, then the exact session.
        db.refresh(identity.user, with_for_update={"read": True})
        if not is_active_account(db, identity.user):
            raise HTTPException(401, detail="Invalid authentication credentials")
        membership = resolve_membership(request, db, identity, payload.org_id)
        db.refresh(membership, with_for_update={"read": True})
        # Re-evaluate after waiting for a membership writer, before changing selection.
        membership = resolve_membership(request, db, identity, payload.org_id)
        require_live_session(db, actor_id=identity.user.id, session_id=identity.session_id)
        session = db.get(IdentitySession, identity.session_id)
        assert session is not None
        session.active_org_id = membership.org_id
        result = self_profile_response(db, identity.user, membership)
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except (SQLAlchemyError, SupabaseAuthUnavailable) as error:
        db.rollback()
        raise HTTPException(503, detail="Organization selection unavailable") from error
    response.headers["Cache-Control"] = "private, no-store"
    return result


@router.post("/invitations/{invitation_id}/accept", status_code=204)
def accept_membership_invitation(
    invitation_id: UUID,
    identity: Annotated[CurrentIdentity, Depends(get_account_identity)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    try:
        db.refresh(identity.user, with_for_update={"read": True})
        if not is_active_account(db, identity.user):
            raise HTTPException(401, detail="Invalid authentication credentials")
        membership = db.get(Membership, invitation_id, populate_existing=True, with_for_update=True)
        if membership is None or membership.user_id != identity.user.id or membership.is_deleted:
            raise HTTPException(404, detail="Invitation not found")
        org = db.get(WorkspaceProfile, membership.org_id, populate_existing=True)
        if org is None or org.is_deleted:
            raise HTTPException(404, detail="Organization not found")
        now = utc_now()
        if (membership.status != "pending" or membership.invitation_accepted_at is not None
            or membership.invitation_sent_at is None
            or membership.invitation_sent_at + timedelta(days=org.invitation_expiry_days) <= now
            or (membership.expires_at is not None and membership.expires_at <= now)):
            raise HTTPException(409, detail="Invitation is no longer pending")
        require_live_session(db, actor_id=identity.user.id, session_id=identity.session_id)
        membership.status = "active"
        membership.invitation_accepted_at = now
        membership.mfa_required_since = now if mfa_role_required(org, membership.role) else None
        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(503, detail="Invitation acceptance unavailable") from error
    return Response(status_code=204)
