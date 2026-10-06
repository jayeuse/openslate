"""Self-service and exact-administrator controls for local identity sessions."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement
from uuid6 import uuid7

from app.common.dependencies import CurrentIdentity, get_current_identity, require_fresh_exact_admin
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.auth.cookies import clear_browser_session
from app.systems.access.auth.request_security import (
    require_completed_identity as _require_completed_identity,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.session_revocation import revoke_session, revoke_user_sessions
from app.systems.access.users.coordination import get_user as load_user
from app.systems.access.users.models import User
from app.systems.access.users.sessions_schemas import (
    AdminSessionCollectionItem,
    AdminSessionCollectionRequest,
    AdminSessionCollectionResponse,
    AdminSessionCollectionSortField,
    AdminSessionListRequest,
    AdminSessionListResponse,
    AdminSessionResponse,
    AdminSessionSortField,
)
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event
from app.systems.manage.workspace.security_policy import (
    effective_session_expiry,
    load_workspace_policy,
    session_expiry_expression,
)

router = APIRouter(prefix="/users", tags=["users"])
auth_router = APIRouter(prefix="/auth", tags=["auth"])

SESSION_LIST_SPEC = ListQuerySpec(
    sort_fields={
        AdminSessionSortField.REFRESHED_AT: cast(ColumnElement[Any], IdentitySession.refreshed_at),
    },
    default_sort=AdminSessionSortField.REFRESHED_AT,
    tie_breaker=cast(ColumnElement[Any], IdentitySession.id),
)

PERSON_NAME = cast(
    ColumnElement[str],
    func.coalesce(func.nullif(func.trim(User.display_name), ""), User.username),
)
USER_AGENT = func.lower(func.coalesce(IdentitySession.user_agent, ""))
DEVICE = cast(
    ColumnElement[str],
    case(
        (
            or_(
                USER_AGENT.contains("ipad"),
                USER_AGENT.contains("tablet"),
                and_(USER_AGENT.contains("android"), ~USER_AGENT.contains("mobile")),
            ),
            "Tablet",
        ),
        (or_(USER_AGENT.contains("mobile"), USER_AGENT.contains("iphone")), "Mobile"),
        (
            or_(
                *(
                    USER_AGENT.contains(name)
                    for name in ("windows", "macintosh", "x11", "linux", "cros")
                )
            ),
            "Desktop",
        ),
        else_="Unknown",
    ),
)
BROWSER = cast(
    ColumnElement[str],
    case(
        (
            or_(*(USER_AGENT.contains(name) for name in ("edg/", "edga/", "edgios/", "edge/"))),
            "Edge",
        ),
        (or_(USER_AGENT.contains("firefox"), USER_AGENT.contains("fxios/")), "Firefox"),
        (or_(USER_AGENT.contains("chrome"), USER_AGENT.contains("crios/")), "Chrome"),
        (USER_AGENT.contains("safari"), "Safari"),
        else_="Unknown",
    ),
)
SESSION_COLLECTION_SPEC = ListQuerySpec(
    sort_fields={
        AdminSessionCollectionSortField.REFRESHED_AT: cast(
            ColumnElement[Any], IdentitySession.refreshed_at
        ),
        AdminSessionCollectionSortField.PERSON_NAME: func.lower(PERSON_NAME),
    },
    default_sort=AdminSessionCollectionSortField.REFRESHED_AT,
    tie_breaker=cast(ColumnElement[Any], IdentitySession.id),
    search_fields=(
        PERSON_NAME,
        cast(ColumnElement[str], User.username),
        USER_AGENT,
        DEVICE,
        BROWSER,
    ),
)


def _require_admin(identity: CurrentIdentity, db: Session) -> UUID:
    _require_completed_identity(identity)
    return require_fresh_exact_admin(db, identity.user.id).id


def _record_revocation(
    db: Session,
    *,
    actor_id: UUID,
    target_id: UUID,
    scope: str,
) -> None:
    append_security_event(
        db,
        SecurityEventIngestRequest(
            event_type="identity.session_revocation",
            outcome=SecurityEventOutcome.SUCCESS,
            source="users.sessions",
            operation_id=uuid7(),
            actor_id=actor_id,
            subject_id=target_id,
            labels={"scope": scope},
        ),
    )


def _commit_revocation(db: Session) -> None:
    try:
        db.commit()
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session revocation is unavailable",
        ) from error


@auth_router.get("/sessions", response_model=list[AdminSessionResponse])
def list_sessions(
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
) -> list[AdminSessionResponse]:
    identity = _require_completed_identity(identity)
    policy = load_workspace_policy(db)
    sessions = db.scalars(
        select(IdentitySession)
        .where(
            IdentitySession.user_id == identity.user.id,
            IdentitySession.revoked_at.is_(None),
            IdentitySession.expires_at > utc_now(),
            session_expiry_expression(policy) > utc_now(),
        )
        .order_by(IdentitySession.refreshed_at.desc(), IdentitySession.id)
    ).all()
    return [
        AdminSessionResponse(
            id=item.id,
            created_at=item.created_at,
            refreshed_at=item.refreshed_at,
            expires_at=effective_session_expiry(item, policy),
            user_agent=item.user_agent,
            ip_address=str(item.ip_address) if item.ip_address is not None else None,
            current=item.id == identity.session_id,
        )
        for item in sessions
    ]


@auth_router.get("/admin-sessions", response_model=AdminSessionCollectionResponse)
def list_admin_sessions(
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[AdminSessionCollectionRequest, Query()],
    response: Response,
) -> AdminSessionCollectionResponse:
    _require_admin(identity, db)
    policy = load_workspace_policy(db)
    statement = (
        select(IdentitySession)
        .join(User, User.id == IdentitySession.user_id)
        .where(
            IdentitySession.revoked_at.is_(None),
            IdentitySession.expires_at > utc_now(),
            session_expiry_expression(policy) > utc_now(),
        )
    )
    if params.status == "current":
        statement = statement.where(IdentitySession.id == identity.session_id)
    elif params.status == "remote":
        statement = statement.where(IdentitySession.id != identity.session_id)
    if params.device != "all":
        statement = statement.where(DEVICE == params.device)
    result = execute_standard_list(db, statement, params, SESSION_COLLECTION_SPEC)
    metadata = {
        row["session_id"]: row
        for row in db.execute(
            select(
                IdentitySession.id.label("session_id"),
                PERSON_NAME.label("person_name"),
                DEVICE.label("device"),
                BROWSER.label("browser"),
            )
            .join(User, User.id == IdentitySession.user_id)
            .where(IdentitySession.id.in_([item.id for item in result.items]))
        )
        .mappings()
        .all()
    }
    response.headers["Cache-Control"] = "no-store"
    return AdminSessionCollectionResponse(
        items=[
            AdminSessionCollectionItem(
                id=item.id,
                user_id=item.user_id,
                person_name=metadata[item.id]["person_name"],
                device=metadata[item.id]["device"],
                browser=metadata[item.id]["browser"],
                user_agent=item.user_agent,
                ip_address=str(item.ip_address) if item.ip_address is not None else None,
                created_at=item.created_at,
                refreshed_at=item.refreshed_at,
                expires_at=effective_session_expiry(item, policy),
                current=item.id == identity.session_id,
            )
            for item in result.items
        ],
        pagination=result.pagination,
    )


@auth_router.delete("/admin-sessions", status_code=status.HTTP_204_NO_CONTENT)
def revoke_admin_session_collection(
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    actor_id = _require_admin(identity, db)
    timestamp = utc_now()
    try:
        sessions = db.scalars(
            select(IdentitySession)
            .where(
                IdentitySession.revoked_at.is_(None),
                IdentitySession.expires_at > timestamp,
                IdentitySession.id != identity.session_id,
            )
            .order_by(IdentitySession.id)
            .execution_options(populate_existing=True)
            .with_for_update(of=IdentitySession)
        ).all()
        affected_users = {
            item.user_id
            for item in sessions
            if revoke_session(db, item.id, item.user_id, now=timestamp)
        }
        for user_id in sorted(affected_users):
            _record_revocation(
                db,
                actor_id=actor_id,
                target_id=user_id,
                scope="others" if user_id == actor_id else "all",
            )
        if affected_users:
            _commit_revocation(db)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Session revocation is unavailable") from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@auth_router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_one_session(
    session_id: UUID,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    identity = _require_completed_identity(identity)
    try:
        if revoke_session(db, session_id, identity.user.id):
            _record_revocation(
                db, actor_id=identity.user.id, target_id=identity.user.id, scope="one"
            )
            _commit_revocation(db)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Session revocation is unavailable") from error
    response.status_code = status.HTTP_204_NO_CONTENT
    if session_id == identity.session_id:
        clear_browser_session(response)
    return response


@auth_router.post("/sessions/revoke-others", status_code=status.HTTP_204_NO_CONTENT)
def revoke_other_sessions(
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    response: Response,
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    identity = _require_completed_identity(identity)
    try:
        if revoke_user_sessions(db, identity.user.id, except_session_id=identity.session_id):
            _record_revocation(
                db, actor_id=identity.user.id, target_id=identity.user.id, scope="others"
            )
            _commit_revocation(db)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(status_code=503, detail="Session revocation is unavailable") from error
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/{user_id}/sessions", response_model=AdminSessionListResponse)
def list_user_sessions(
    user_id: UUID,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[AdminSessionListRequest, Query()],
) -> AdminSessionListResponse:
    _require_admin(identity, db)
    target = load_user(db, user_id)
    policy = load_workspace_policy(db)
    result = execute_standard_list(
        db,
        select(IdentitySession).where(
            IdentitySession.user_id == target.id,
            IdentitySession.revoked_at.is_(None),
            IdentitySession.expires_at > utc_now(),
            session_expiry_expression(policy) > utc_now(),
        ),
        params,
        SESSION_LIST_SPEC,
    )
    return AdminSessionListResponse(
        items=[
            AdminSessionResponse(
                id=item.id,
                created_at=item.created_at,
                refreshed_at=item.refreshed_at,
                expires_at=effective_session_expiry(item, policy),
                user_agent=item.user_agent,
                ip_address=str(item.ip_address) if item.ip_address is not None else None,
                current=item.id == identity.session_id,
            )
            for item in result.items
        ],
        pagination=result.pagination,
    )


@router.delete("/{user_id}/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_user_session(
    user_id: UUID,
    session_id: UUID,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    actor_id = _require_admin(identity, db)
    target = load_user(db, user_id)
    if target.id == identity.user.id and session_id == identity.session_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You cannot revoke your current session",
        )
    try:
        if revoke_session(db, session_id, target.id):
            _record_revocation(db, actor_id=actor_id, target_id=target.id, scope="one")
            _commit_revocation(db)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session revocation is unavailable",
        ) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/{user_id}/sessions", status_code=status.HTTP_204_NO_CONTENT)
def revoke_user_session_collection(
    user_id: UUID,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
) -> Response:
    actor_id = _require_admin(identity, db)
    target = load_user(db, user_id)
    preserving_current = target.id == identity.user.id
    current_session_id = identity.session_id if preserving_current else None
    try:
        if revoke_user_sessions(db, target.id, except_session_id=current_session_id):
            _record_revocation(
                db,
                actor_id=actor_id,
                target_id=target.id,
                scope="others" if preserving_current else "all",
            )
            _commit_revocation(db)
    except SQLAlchemyError as error:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Session revocation is unavailable",
        ) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)
