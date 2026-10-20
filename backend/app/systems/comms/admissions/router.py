"""Uniform private requests and current-manager admission, never self-approval or discovery."""

import hashlib
import json
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Response
from sqlalchemy import Select, select
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import error, fresh_membership
from app.systems.comms.admissions.audience import managers
from app.systems.comms.admissions.models import CommsAdmission
from app.systems.comms.conversations import service
from app.systems.comms.conversations.models import CommsCategory, CommsConversation, CommsMember
from app.systems.comms.messages.interaction_schemas import TimeList, TimeSort
from app.systems.comms.messages.schemas import WireModel
from app.systems.comms.moderation.service import match
from app.systems.comms.realtime.events import membership_event, user_event
from app.systems.comms.realtime.grants import lock_projection, revoke_stale
from app.systems.comms.settings.resolution import resolve_settings
from app.systems.manage.workspace.models import WorkspaceProfile

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
Match = Annotated[str | None, Header(alias="If-Match")]
router = APIRouter(prefix="/comms", tags=["comms"], dependencies=[Depends(get_current_membership)])


class Submission(WireModel):
    conversation_id: UUID


class Invitation(WireModel):
    user_id: UUID


class Decision(WireModel):
    decision: Literal["accept", "decline"]


class Admission(WireModel):
    id: UUID
    org_id: UUID
    conversation_id: UUID
    user_id: UUID
    kind: Literal["request", "invitation"]
    status: Literal["pending", "accepted", "declined"]
    resolved_at: datetime | None
    created_at: datetime
    updated_at: datetime


def version(row: CommsAdmission) -> str:
    return (
        '"'
        + hashlib.sha256(
            json.dumps(
                Admission.model_validate(row).model_dump(mode="json"), sort_keys=True
            ).encode()
        ).hexdigest()
        + '"'
    )


def _query(conversation_id: UUID) -> Select[tuple[CommsAdmission]]:
    return (
        select(CommsAdmission)
        .where(
            CommsAdmission.org_id == bound_organization_column(),
            CommsAdmission.conversation_id == conversation_id,
            CommsAdmission.is_deleted.is_(False),
        )
        .execution_options(populate_existing=True)
    )


def policy(db: Session, room: CommsConversation) -> str:
    db.scalar(
        select(WorkspaceProfile.id)
        .where(
            WorkspaceProfile.id == bound_organization_column(),
        )
        .with_for_update(read=True)
    )
    if room.category_id is not None:
        db.scalar(
            select(CommsCategory.id)
            .where(
                CommsCategory.org_id == bound_organization_column(),
                CommsCategory.id == room.category_id,
            )
            .with_for_update(read=True)
        )
    return str(resolve_settings(db, {"kind": "channel", "id": room.id})["effective"]["join_rule"])


def managed(db: Session, actor: User, identity: UUID) -> CommsConversation:
    room = service.manage_conversation(db, actor, identity)
    service.require_channel(room)
    policy(db, room)
    return room


def pending(db: Session, identity: UUID, user: UUID) -> CommsAdmission | None:
    return db.scalar(
        _query(identity).where(CommsAdmission.user_id == user, CommsAdmission.status == "pending")
    )


def active_member(db: Session, identity: UUID, user: UUID) -> bool:
    return (
        db.scalar(
            select(CommsMember.id).where(
                CommsMember.org_id == bound_organization_column(),
                CommsMember.conversation_id == identity,
                CommsMember.user_id == user,
                CommsMember.is_deleted.is_(False),
                CommsMember.deleted_at.is_(None),
            )
        )
        is not None
    )


def changed(db: Session, room: CommsConversation) -> None:
    db.flush()
    for identity in managers(db, room.id):
        user_event(db, identity, "structure", {})


@router.get(
    "/conversations/{conversation_id}/admissions", response_model=StandardListResponse[Admission]
)
def list_admissions(
    conversation_id: UUID,
    db: DB,
    actor: Actor,
    http: Response,
    params: Annotated[TimeList, Query()],
) -> Any:
    managed(db, actor, conversation_id)
    service.private(http)
    page = execute_standard_list(
        db,
        _query(conversation_id),
        StandardListRequest[TimeSort](**params.model_dump()),
        ListQuerySpec(
            sort_fields={
                TimeSort.CREATED: CommsAdmission.created_at.expression,
                TimeSort.UPDATED: CommsAdmission.updated_at.expression,
            },
            default_sort=TimeSort.CREATED,
            tie_breaker=CommsAdmission.id.expression,
        ),
    )
    return StandardListResponse(
        items=[Admission.model_validate(row) for row in page.items], pagination=page.pagination
    )


@router.get("/conversations/{conversation_id}/admissions/{admission_id}", response_model=Admission)
def get_admission(
    conversation_id: UUID, admission_id: UUID, db: DB, actor: Actor, http: Response
) -> Admission:
    managed(db, actor, conversation_id)
    row = db.scalar(_query(conversation_id).where(CommsAdmission.id == admission_id))
    if row is None:
        raise error("comms_not_found", "Admission not found")
    service.private(http)
    http.headers["ETag"] = version(row)
    return Admission.model_validate(row)


@router.post("/join-requests", status_code=204)
def submit(payload: Submission, db: DB, actor: Actor, http: Response) -> None:
    with service.transaction(db):
        lock_projection(db)
        room = db.scalar(
            select(CommsConversation)
            .where(
                CommsConversation.org_id == bound_organization_column(),
                CommsConversation.id == payload.conversation_id,
                CommsConversation.kind == "channel",
                CommsConversation.scope == "members",
                CommsConversation.is_deleted.is_(False),
                CommsConversation.deleted_at.is_(None),
                CommsConversation.archived_at.is_(None),
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if fresh_membership(db, actor) is None:
            raise error("comms_post_denied", "Account is unavailable", 403)
        service.private(http)
        if (
            room is None
            or active_member(db, room.id, actor.id)
            or pending(db, room.id, actor.id) is not None
            or policy(db, room) != "request"
        ):
            return
        db.add(
            CommsAdmission(
                org_id=bound_organization(db),
                conversation_id=room.id,
                user_id=actor.id,
                kind="request",
            )
        )
        changed(db, room)


@router.post(
    "/conversations/{conversation_id}/invitations", response_model=Admission, status_code=201
)
def invite(
    conversation_id: UUID, payload: Invitation, db: DB, actor: Actor, http: Response
) -> Admission:
    with service.transaction(db):
        room = managed(db, actor, conversation_id)
        service.require_people(db, [payload.user_id])
        if (
            room.archived_at is not None
            or active_member(db, room.id, payload.user_id)
            or pending(db, room.id, payload.user_id) is not None
        ):
            raise error("comms_conflict", "Person cannot be invited in the current state", 409)
        row = CommsAdmission(
            org_id=bound_organization(db),
            conversation_id=room.id,
            user_id=payload.user_id,
            kind="invitation",
        )
        db.add(row)
        changed(db, room)
        service.private(http)
        http.headers.update(
            {
                "ETag": version(row),
                "Location": f"/api/comms/conversations/{room.id}/admissions/{row.id}",
            }
        )
        result = Admission.model_validate(row)
    return result


@router.post(
    "/conversations/{conversation_id}/admissions/{admission_id}/decision", response_model=Admission
)
def decide(
    conversation_id: UUID,
    admission_id: UUID,
    payload: Decision,
    db: DB,
    actor: Actor,
    http: Response,
    if_match: Match = None,
) -> Admission:
    with service.transaction(db):
        room = managed(db, actor, conversation_id)
        row = db.scalar(_query(room.id).where(CommsAdmission.id == admission_id).with_for_update())
        if row is None:
            raise error("comms_not_found", "Admission not found")
        match(if_match, version(row))
        if row.status != "pending":
            raise error("comms_conflict", "Admission is already resolved", 409)
        added = False
        if payload.decision == "accept":
            service.require_people(db, [row.user_id])
            if room.archived_at is not None or (
                row.kind == "request" and policy(db, room) != "request"
            ):
                raise error("comms_conflict", "Admission is no longer permitted", 409)
            if not active_member(db, room.id, row.user_id):
                member = db.scalar(
                    select(CommsMember)
                    .where(
                        CommsMember.org_id == bound_organization_column(),
                        CommsMember.conversation_id == room.id,
                        CommsMember.user_id == row.user_id,
                    )
                    .order_by(CommsMember.id.desc())
                    .limit(1)
                    .with_for_update()
                )
                if member is None:
                    db.add(
                        CommsMember(
                            org_id=room.org_id,
                            conversation_id=room.id,
                            user_id=row.user_id,
                            role="member",
                        )
                    )
                else:
                    member.is_deleted, member.deleted_at, member.role = False, None, "member"
                    member.joined_at = utc_now()
                room.updated_at = utc_now()
                added = True
        row.status = "accepted" if payload.decision == "accept" else "declined"
        row.resolved_at = utc_now()
        db.flush()
        managed(db, actor, conversation_id)
        if payload.decision == "accept":
            service.require_people(db, [row.user_id])
        changed(db, room)
        if added:
            revoke_stale(db)
            membership_event(db, room, row.user_id)
        service.private(http)
        http.headers["ETag"] = version(row)
        result = Admission.model_validate(row)
    return result
