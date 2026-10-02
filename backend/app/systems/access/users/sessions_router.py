"""Exact-administrator controls for a user's active local identity sessions."""

from typing import Annotated, Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement
from uuid6 import uuid7

from app.common.dependencies import CurrentIdentity, get_current_identity, require_fresh_exact_admin
from app.common.listing import ListQuerySpec, execute_standard_list
from app.core.base_model import utc_now
from app.core.database import get_db
from app.systems.access.auth.request_security import (
    require_completed_identity as _require_completed_identity,
)
from app.systems.access.identity.models import IdentitySession
from app.systems.access.identity.session_revocation import revoke_session, revoke_user_sessions
from app.systems.access.users.coordination import get_user as load_user
from app.systems.access.users.sessions_schemas import (
    AdminSessionListRequest,
    AdminSessionListResponse,
    AdminSessionResponse,
    AdminSessionSortField,
)
from app.systems.manage.audit.models import SecurityEventOutcome
from app.systems.manage.audit.schemas import SecurityEventIngestRequest
from app.systems.manage.audit.service import append_security_event

router = APIRouter(prefix="/users", tags=["users"])
auth_router = APIRouter(prefix="/auth", tags=["auth"])

SESSION_LIST_SPEC = ListQuerySpec(
    sort_fields={
        AdminSessionSortField.REFRESHED_AT: cast(ColumnElement[Any], IdentitySession.refreshed_at),
    },
    default_sort=AdminSessionSortField.REFRESHED_AT,
    tie_breaker=cast(ColumnElement[Any], IdentitySession.id),
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
    sessions = db.scalars(
        select(IdentitySession)
        .where(
            IdentitySession.user_id == identity.user.id,
            IdentitySession.revoked_at.is_(None),
            IdentitySession.expires_at > utc_now(),
        )
        .order_by(IdentitySession.refreshed_at.desc(), IdentitySession.id)
    ).all()
    return [
        AdminSessionResponse(
            id=item.id,
            created_at=item.created_at,
            refreshed_at=item.refreshed_at,
            expires_at=item.expires_at,
            user_agent=item.user_agent,
            current=item.id == identity.session_id,
        )
        for item in sessions
    ]


@router.get("/{user_id}/sessions", response_model=AdminSessionListResponse)
def list_user_sessions(
    user_id: UUID,
    identity: Annotated[CurrentIdentity, Depends(get_current_identity)],
    db: Annotated[Session, Depends(get_db)],
    params: Annotated[AdminSessionListRequest, Query()],
) -> AdminSessionListResponse:
    _require_admin(identity, db)
    target = load_user(db, user_id)
    result = execute_standard_list(
        db,
        select(IdentitySession).where(
            IdentitySession.user_id == target.id,
            IdentitySession.revoked_at.is_(None),
            IdentitySession.expires_at > utc_now(),
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
                expires_at=item.expires_at,
                user_agent=item.user_agent,
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
