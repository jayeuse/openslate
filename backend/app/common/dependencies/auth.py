from dataclasses import dataclass
from typing import Annotated, cast
from uuid import UUID

from fastapi import Depends, Header, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import Integer, func, literal, select
from sqlalchemy import cast as sql_cast
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.config.development import browser_origin_is_permitted
from app.core.database import get_db
from app.core.database.organization_scope import scope_session
from app.core.integrations.supabase_auth import (
    InvalidProviderCredentials,
    InvalidProviderToken,
    SupabaseAuthUnavailable,
    get_supabase_auth_client,
)
from app.systems.access.identity.mfa import MFARequired, requires_mfa
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.provider_sessions import resolve_provider_session, validate_csrf
from app.systems.access.identity.provider_user_cache import recent_provider_user
from app.systems.access.users.eligibility import is_active_account, is_active_membership
from app.systems.access.users.membership import (
    bound_organization,
    organization_membership,
    organization_required,
    remember_membership,
    require_current_membership,
)
from app.systems.access.users.models import Membership, User, UserRole
from app.systems.access.users.schemas import DefaultOrganizationBlocked
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.security_failures import append_committed_failure
from app.systems.manage.audit.service import SecurityEventPersistenceError
from app.systems.manage.workspace.models import WorkspaceProfile
from app.systems.manage.workspace.security_policy import (
    ip_allowed,
    load_platform_policy,
)

_bearer = HTTPBearer(auto_error=False)
_UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
# One transaction-scoped advisory lock per organization orders administrator changes.
# Administrator actions hold it shared; changes that can remove an administrator
# hold it exclusively, so the last-administrator count cannot race.
ADMINISTRATOR_CHANGE_LOCK = 0x4F53_4144  # "OSAD"


@dataclass(frozen=True, slots=True)
class CurrentIdentity:
    user: User
    session_id: UUID
    cookie_authenticated: bool
    setup_only: bool
    assurance_level: str = "aal1"


@dataclass(frozen=True, slots=True)
class AccountOrganization:
    membership: Membership | None
    default_organization_blocked: DefaultOrganizationBlocked | None = None


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_identity(
    request: Request,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    db: Annotated[Session, Depends(get_db)],
) -> CurrentIdentity:
    identity = get_account_identity(request, bearer, db)
    raw_org = request.headers.get("X-Org")
    try:
        org_id = UUID(raw_org) if raw_org is not None else None
    except ValueError as error:
        raise RequestValidationError([{
            "type": "uuid_parsing", "loc": ("header", "x-org"),
            "msg": "Input should be a valid UUID", "input": raw_org,
        }]) from error
    if get_optional_membership(request, identity, db, org_id) is None:
        raise organization_required()
    return identity


def get_account_identity(
    request: Request,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    db: Annotated[Session, Depends(get_db)],
) -> CurrentIdentity:
    return _resolve_identity(request, bearer, db, allow_aal1=False)


def get_mfa_identity(
    request: Request,
    bearer: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    db: Annotated[Session, Depends(get_db)],
) -> CurrentIdentity:
    """Allow only MFA completion/logout to use an otherwise fully admitted AAL1 session."""
    return _resolve_identity(request, bearer, db, allow_aal1=True)


def _resolve_identity(
    request: Request,
    bearer: HTTPAuthorizationCredentials | None,
    db: Session,
    *,
    allow_aal1: bool,
) -> CurrentIdentity:
    cookie_token = request.cookies.get("openslate_access")
    refresh_cookie = request.cookies.get("openslate_refresh")
    bearer_token = bearer.credentials if bearer is not None else None
    if request.headers.get("authorization") and (cookie_token or refresh_cookie):
        raise _unauthorized()
    if bool(cookie_token) == bool(bearer_token):
        raise _unauthorized()
    raw_token = cookie_token or bearer_token
    if raw_token is None:
        raise _unauthorized()
    client = get_supabase_auth_client()
    try:
        claims = client.verify_access_token(raw_token)
        resolved = resolve_provider_session(
            db, claims, client, allow_aal1=allow_aal1, policy=load_platform_policy(db)
        )
    except MFARequired as error:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "mfa_required",
                "message": "Complete multi-factor authentication to continue",
            },
        ) from error
    except InvalidProviderToken as error:
        raise _unauthorized() from error
    except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
        raise HTTPException(status_code=503, detail="Authentication service unavailable") from error
    if resolved is None:
        raise _unauthorized()
    user, session = resolved
    session_id = session.id
    cookie_authenticated = cookie_token is not None
    if cookie_authenticated and request.method in _UNSAFE_METHODS:
        _validate_cookie_mutation(request, db, session_id)
    if isinstance(db.info, dict):
        set_audit_actor(db, user.id)
    return CurrentIdentity(user, session_id, cookie_authenticated, False, claims.assurance_level)


def require_allowed_source(
    request: Request,
    db: Session,
    policy: WorkspaceProfile | None = None,
    *,
    person_id: UUID | None = None,
) -> None:
    # Account/anonymous routes have no organization transport policy. Organization
    # entry always supplies its persisted policy, never a singleton fallback.
    if policy is None:
        return
    try:
        permitted = ip_allowed(
            policy,
            request.client.host if request.client else None,
        )
    except (SupabaseAuthUnavailable, SQLAlchemyError) as error:
        raise HTTPException(status_code=503, detail="Authentication service unavailable") from error
    if not permitted:
        source = request.client.host if request.client else None
        db.rollback()
        try:
            append_committed_failure(
                "identity.ip_blocked", source, actor_id=person_id, subject_id=person_id
            )
        except SecurityEventPersistenceError as error:
            raise HTTPException(503, detail="Authentication service unavailable") from error
        raise HTTPException(
            status_code=403,
            detail={"code": "ip_not_allowed", "message": "Access from this address is not allowed"},
        )


def _validate_cookie_mutation(request: Request, db: Session, session_id: UUID) -> None:
    if not browser_origin_is_permitted(get_settings(), request.headers.get("origin")):
        raise _unauthorized()
    session = db.get(IdentitySession, session_id)
    if session is None or not validate_csrf(session, request.headers.get("X-CSRF-Token", "")):
        raise _unauthorized()


def get_account_user(identity: Annotated[CurrentIdentity, Depends(get_account_identity)]) -> User:
    if identity.setup_only:
        raise _unauthorized()
    return identity.user


def resolve_membership(
    request: Request, db: Session, identity: CurrentIdentity, org_id: UUID,
) -> Membership:
    org = db.get(WorkspaceProfile, org_id, populate_existing=True)
    if org is None or org.is_deleted:
        raise HTTPException(404, detail="Organization not found")
    membership = db.scalar(select(Membership).where(
        Membership.org_id == org_id, Membership.user_id == identity.user.id,
    ).execution_options(populate_existing=True))
    if membership is None or not is_active_membership(identity.user, membership):
        raise organization_required()
    provider_id = identity.user.supabase_user_id
    if provider_id is None:
        raise _unauthorized()
    provider_user = recent_provider_user(provider_id)
    if provider_user is None:
        try:
            provider_user = get_supabase_auth_client().get_admin_user(provider_id)
        except InvalidProviderCredentials as error:
            raise _unauthorized() from error
    if requires_mfa(org, membership, provider_user) and (
        identity.assurance_level != "aal2" or not any(
            factor.factor_type == "totp" and factor.status == "verified"
            for factor in provider_user.factors
        )
    ):
        raise HTTPException(403, detail={
            "code": "mfa_required", "message": "Complete multi-factor authentication to continue",
        })
    require_allowed_source(request, db, org, person_id=identity.user.id)
    scope_session(db, org_id)
    remember_membership(db, membership)
    return membership


def get_optional_membership(
    request: Request,
    identity: Annotated[CurrentIdentity, Depends(get_account_identity)],
    db: Annotated[Session, Depends(get_db)],
    x_org: Annotated[UUID | None, Header()] = None,
) -> Membership | None:
    session = db.get(IdentitySession, identity.session_id)
    org_id = x_org if x_org is not None else session.active_org_id if session else None
    if org_id is None:
        return None
    try:
        return resolve_membership(request, db, identity, org_id)
    except (SQLAlchemyError, SupabaseAuthUnavailable) as error:
        raise HTTPException(503, detail="Organization context unavailable") from error


def get_account_organization(
    request: Request,
    identity: Annotated[CurrentIdentity, Depends(get_account_identity)],
    db: Annotated[Session, Depends(get_db)],
    x_org: Annotated[UUID | None, Header()] = None,
) -> AccountOrganization:
    """A refused implicit default never grants organization authority or strands the account."""
    try:
        return AccountOrganization(get_optional_membership(request, identity, db, x_org))
    except HTTPException as error:
        code = error.detail.get("code") if isinstance(error.detail, dict) else None
        if x_org is None and error.status_code == 403 and code in (
            "organization_required", "mfa_required", "ip_not_allowed",
        ):
            return AccountOrganization(None, cast(DefaultOrganizationBlocked, code))
        raise


def get_current_membership(
    membership: Annotated[Membership | None, Depends(get_optional_membership)],
) -> Membership:
    if membership is None:
        raise organization_required()
    return membership


def get_current_user(
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
) -> User:
    return get_account_user(identity)


def _forbidden(db: Session) -> HTTPException:
    db.rollback()
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def lock_administrator_changes(
    db: Session, *, exclusive: bool, org_id: UUID | None = None
) -> None:
    """Take the transaction-scoped administrator lock of one organization.

    Organizations change administrators independently; the lock and the
    last-administrator counts are per organization (the bound one by default).
    """

    organization = org_id or bound_organization(db)
    lock = func.pg_advisory_xact_lock if exclusive else func.pg_advisory_xact_lock_shared
    db.execute(select(lock(
        sql_cast(literal(ADMINISTRATOR_CHANGE_LOCK), Integer),
        func.hashtext(str(organization)),
    )))


def require_fresh_exact_admin(
    db: Session, actor_id: UUID, *, serialize_admin_changes: bool = False
) -> User:
    """Reload the actor under the administrator lock and require an active administrator."""

    try:
        lock_administrator_changes(db, exclusive=serialize_admin_changes)
        actor = db.scalar(
            select(User)
            .where(User.id == actor_id)
            .execution_options(populate_existing=True)
            .with_for_update(of=User, read=True)
        )
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Unable to reload administrator") from error
    # Re-read the membership under the lock too: a demotion may have committed meanwhile.
    membership = (
        organization_membership(db, actor.id, fresh=True) if isinstance(actor, User) else None
    )
    if (
        not isinstance(actor, User)
        or membership is None
        or not is_active_account(db, actor)
        or not is_active_membership(actor, membership)
        or membership.role != UserRole.ADMIN.value
    ):
        raise _forbidden(db)
    return actor


def require_admin(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    """Allow only an administrator.

    Administrators alone change the schema, users, invitations and group access.
    Department managers change group members through ``policy/delegation.py`` instead.
    """

    if require_current_membership(db, user).role != UserRole.ADMIN.value:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return user


def require_non_guest(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> User:
    """Allow administrators and members. A guest is limited to reading."""

    if require_current_membership(db, user).role == UserRole.GUEST.value:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return user
