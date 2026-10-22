"""D45 access grants: added read or post on a channel or a category, managed by its managers.

A category grant applies to every channel currently in that category; nothing is copied.
Grants only add access and never give manage. The level itself is decided in
``comms/access.py``; these routes only store the rows and refresh the Realtime grants.
"""

from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Path, Query, Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_db
from app.systems.access.policy.models import Group
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.policy.scope import effective_levels
from app.systems.access.users.membership import bound_membership_join, bound_organization
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import error, fresh_membership, require_conversation_access
from app.systems.comms.capabilities import capability_check
from app.systems.comms.conversations import mutations, service
from app.systems.comms.conversations.access_grant_schemas import (
    AccessCandidateQuery,
    AccessCandidates,
    AccessGrant,
    AccessGrantRequest,
    AccessGrants,
    GrantLevel,
    GroupCandidate,
    PersonCandidate,
    Subject,
)
from app.systems.comms.conversations.models import (
    CommsCategory,
    CommsChannelAccess,
    CommsConversation,
)
from app.systems.comms.conversations.reads import person_departments
from app.systems.comms.realtime.events import organization_event
from app.systems.comms.realtime.grants import lock_projection, revoke_stale

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
Match = Annotated[str | None, Header(alias="If-Match")]
SubjectPath = Annotated[Subject, Path()]
ETAG = {"ETag": {"description": "Target configuration token", "schema": {"type": "string"}}}
VERSIONED: dict[int | str, dict[str, Any]] = {200: {"headers": ETAG}}
WRITTEN: dict[int | str, dict[str, Any]] = {
    200: {"headers": ETAG},
    201: {"headers": {**ETAG, "Location": {"schema": {"type": "string"}}}},
}
router = APIRouter(
    prefix="/comms",
    tags=["comms"],
    dependencies=[Depends(get_current_membership)],
    responses={
        403: {"description": "The target cannot be managed by this person"},
        404: {"description": "Absent or unreadable target, person, group or grant"},
        409: {"description": "Grant changed concurrently; no changes saved"},
        412: {"description": "Target configuration changed"},
        422: {"description": "Direct and group messages cannot have grants"},
        428: {"description": "If-Match is required"},
        503: {"description": "Grant operation unavailable"},
    },
)
Target = CommsConversation | CommsCategory
NAME = func.coalesce(func.nullif(User.display_name, ""), User.username)


def _require_manage_channel(db: Session, actor: User, identity: UUID) -> None:
    if not capability_check(db, actor, identity)["capabilities"]["manageChannel"]["allowed"]:
        raise error("comms_capability_denied", "Conversation management is not permitted", 403)


def _read_channel(db: Session, actor: User, identity: UUID) -> CommsConversation:
    row = require_conversation_access(db, actor, identity, "read")
    service.require_channel(row)
    _require_manage_channel(db, actor, identity)
    return row


def _write_channel(db: Session, actor: User, identity: UUID) -> CommsConversation:
    row = service.manage_conversation(db, actor, identity)  # Takes the projection guard.
    service.require_channel(row)
    if row.scope == "organization":
        # Every member already posts there, so a grant would change nothing.
        raise error("comms_invalid", "An organization channel needs no access grants", 422)
    return row


def _category(db: Session, actor: User, identity: UUID, *, write: bool) -> CommsCategory:
    if write:
        lock_projection(db)  # revoke_stale needs the guard before the category lock.
    row = service.require_visible_category(db, actor, identity, lock=write)
    service.require_management(db, actor, {"kind": "category", "id": identity})
    if write:
        _require_category_grant_author(db, actor, row)
    return row


def _require_category_grant_author(db: Session, actor: User, row: CommsCategory) -> None:
    """Only admins and managers of the category's department write category grants.

    A category ``manageChannel`` capability is not enough: its holder could grant
    themselves read on every channel in the category (parent decision, 2026-10-22).
    """
    membership = fresh_membership(db, actor)
    if membership is not None and membership.role == "admin":
        return
    if membership is not None and membership.role != "guest" and row.department_id is not None:
        managed = effective_levels(db, actor, membership=membership).managed_department_ids()
        if managed is None or row.department_id in managed:
            return
    raise error("comms_capability_denied", "Category grants need a department manager", 403)


def _target_clause(row: Target) -> Any:
    if isinstance(row, CommsCategory):
        return CommsChannelAccess.category_id == row.id
    return CommsChannelAccess.conversation_id == row.id


def _grants(db: Session, row: Target) -> list[AccessGrant]:
    """Own grants, and on a channel also its current category's, with live subjects only."""
    grant = CommsChannelAccess
    targets = [_target_clause(row)]
    if isinstance(row, CommsConversation) and row.category_id is not None:
        targets.append(grant.category_id == row.category_id)
    rows = db.scalars(
        select(grant)
        .where(
            grant.org_id == bound_organization_column(),
            grant.is_deleted.is_(False),
            grant.deleted_at.is_(None),
            or_(*targets),
        )
        .execution_options(populate_existing=True)
    ).all()
    users = {r.user_id for r in rows if r.user_id is not None}
    names = _subject_names(db, users, {r.group_id for r in rows if r.group_id is not None})
    departments = person_departments(db, list(users)) if users else {}
    items = [
        AccessGrant(
            subject="group" if r.subject == "group" else "user",
            subject_id=identity,
            display_name=names[identity],
            departments=None if r.user_id is None else departments.get(r.user_id, []),
            level="post" if r.level == "post" else "read",
            source="category" if r.category_id is not None else "channel",
            created_at=r.created_at,
            updated_at=r.updated_at,
        )
        for r in rows
        if (identity := r.group_id or r.user_id) is not None and identity in names
    ]
    items.sort(
        key=lambda item: (
            item.source == "category" and isinstance(row, CommsConversation),
            item.subject != "group",
            item.display_name.casefold(),
            str(item.subject_id),
        )
    )
    return items


def _subject_names(db: Session, users: set[UUID], groups: set[UUID]) -> dict[UUID, str]:
    """Live subjects only: active members of the bound organization and its live groups."""
    rows: list[tuple[UUID, str]] = []
    if users:
        rows += db.execute(
            select(User.id, NAME)
            .join(Membership, bound_membership_join())
            .where(User.id.in_(users), active_account_clause())
        ).tuples()
    if groups:
        rows += db.execute(
            select(Group.id, Group.name).where(
                Group.org_id == bound_organization_column(),
                Group.is_deleted.is_(False),
                Group.id.in_(groups),
            )
        ).tuples()
    return {identity: name for identity, name in rows}


def _require_subject(db: Session, subject: Subject, identity: UUID) -> None:
    users, groups = ({identity}, set()) if subject == "user" else (set(), {identity})
    if identity not in _subject_names(db, users, groups):
        raise error(
            "comms_not_found", "Person not found" if subject == "user" else "Group not found"
        )


def _stored(
    db: Session, row: Target, subject: Subject, identity: UUID
) -> CommsChannelAccess | None:
    grant = CommsChannelAccess
    return db.scalar(
        select(grant)
        .where(
            grant.org_id == bound_organization_column(),
            grant.is_deleted.is_(False),
            grant.deleted_at.is_(None),
            _target_clause(row),
            grant.subject == subject,
            (grant.user_id if subject == "user" else grant.group_id) == identity,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def _put(
    db: AuditSession,
    actor: User,
    row: Target,
    subject: Subject,
    identity: UUID,
    level: GrantLevel,
    if_match: str | None,
    response: Response,
    location: str,
) -> AccessGrant:
    service.match(db, row, if_match)
    _require_subject(db, subject, identity)
    current = _stored(db, row, subject, identity)
    if current is None:
        current = CommsChannelAccess(
            org_id=bound_organization(db),
            conversation_id=row.id if isinstance(row, CommsConversation) else None,
            category_id=row.id if isinstance(row, CommsCategory) else None,
            subject=subject,
            group_id=identity if subject == "group" else None,
            user_id=identity if subject == "user" else None,
            level=level,
            created_by=actor.id,
        )
        db.add(current)
        response.status_code = 201
        response.headers["Location"] = location
    elif current.level != level:
        current.level, current.updated_at = level, utc_now()
    _changed(db, actor, row)
    db.flush()
    db.refresh(current)
    item = next(
        item
        for item in _grants(db, row)
        if item.subject_id == identity and item.source == _kind(row)
    )
    service.headers(db, response, row)
    return item


def _delete(
    db: AuditSession,
    actor: User,
    row: Target,
    subject: Subject,
    identity: UUID,
    if_match: str | None,
    response: Response,
) -> None:
    service.match(db, row, if_match)
    current = _stored(db, row, subject, identity)
    if current is None:
        raise error("comms_not_found", "Grant not found")
    db.delete(current)
    _changed(db, actor, row)
    service.private(response)


def _changed(db: AuditSession, actor: User, row: Target) -> None:
    """Refuse removing the actor's own read; drop stale Realtime grants; tell every member."""
    db.flush()
    if isinstance(row, CommsConversation):
        mutations.retain_read(db, actor, row)
    revoke_stale(db)  # Also sends the organization "grants" event.
    organization_event(db, "structure")


def _kind(row: Target) -> Literal["channel", "category"]:
    return "category" if isinstance(row, CommsCategory) else "channel"


def _path(row: Target, subject: Subject, identity: UUID) -> str:
    collection = "categories" if isinstance(row, CommsCategory) else "conversations"
    return f"/api/comms/{collection}/{row.id}/access-grants/{subject}/{identity}"


def _candidates(db: Session, query: AccessCandidateQuery) -> AccessCandidates:
    pattern = "%" + query.q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    people: list[PersonCandidate] = []
    groups: list[GroupCandidate] = []
    if query.kind != "group":
        rows = db.execute(
            select(User.id, NAME.label("display_name"))
            .join(Membership, bound_membership_join())
            .where(active_account_clause(), NAME.ilike(pattern, escape="\\"))
            .order_by(NAME, User.id)
            .limit(query.limit)
        ).all()
        departments = person_departments(db, [row.id for row in rows])
        people = [
            PersonCandidate.model_validate(
                {
                    "user_id": row.id,
                    "display_name": row.display_name,
                    "departments": departments[row.id],
                }
            )
            for row in rows
        ]
    if query.kind != "user":
        groups = [
            GroupCandidate(id=identity, name=name)
            for identity, name in db.execute(
                select(Group.id, Group.name)
                .where(
                    Group.org_id == bound_organization_column(),
                    Group.is_deleted.is_(False),
                    Group.name.ilike(pattern, escape="\\"),
                )
                .order_by(Group.name, Group.id)
                .limit(query.limit)
            ).tuples()
        ]
    return AccessCandidates(people=people, groups=groups)


# Channel targets ------------------------------------------------------------------------


@router.get(
    "/conversations/{conversation_id}/access-grants",
    response_model=AccessGrants,
    responses=VERSIONED,
)
def list_channel_grants(
    conversation_id: UUID, db: DB, actor: Actor, response: Response
) -> AccessGrants:
    row = _read_channel(db, actor, conversation_id)
    result = AccessGrants(items=_grants(db, row))
    service.headers(db, response, row)
    return result


@router.put(
    "/conversations/{conversation_id}/access-grants/{subject}/{subject_id}",
    response_model=AccessGrant,
    responses=WRITTEN,
)
def put_channel_grant(
    conversation_id: UUID,
    subject: SubjectPath,
    subject_id: UUID,
    payload: AccessGrantRequest,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> AccessGrant:
    with service.transaction(db):
        row = _write_channel(db, actor, conversation_id)
        return _put(
            db,
            actor,
            row,
            subject,
            subject_id,
            payload.level,
            if_match,
            response,
            _path(row, subject, subject_id),
        )


@router.delete(
    "/conversations/{conversation_id}/access-grants/{subject}/{subject_id}", status_code=204
)
def delete_channel_grant(
    conversation_id: UUID,
    subject: SubjectPath,
    subject_id: UUID,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> None:
    with service.transaction(db):
        row = _write_channel(db, actor, conversation_id)
        _delete(db, actor, row, subject, subject_id, if_match, response)


@router.get("/conversations/{conversation_id}/access-candidates", response_model=AccessCandidates)
def list_channel_candidates(
    conversation_id: UUID,
    query: Annotated[AccessCandidateQuery, Query()],
    db: DB,
    actor: Actor,
    response: Response,
) -> AccessCandidates:
    _read_channel(db, actor, conversation_id)
    service.private(response)
    return _candidates(db, query)


# Category targets -----------------------------------------------------------------------


@router.get(
    "/categories/{category_id}/access-grants", response_model=AccessGrants, responses=VERSIONED
)
def list_category_grants(
    category_id: UUID, db: DB, actor: Actor, response: Response
) -> AccessGrants:
    row = _category(db, actor, category_id, write=False)
    result = AccessGrants(items=_grants(db, row))
    service.headers(db, response, row)
    return result


@router.put(
    "/categories/{category_id}/access-grants/{subject}/{subject_id}",
    response_model=AccessGrant,
    responses=WRITTEN,
)
def put_category_grant(
    category_id: UUID,
    subject: SubjectPath,
    subject_id: UUID,
    payload: AccessGrantRequest,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> AccessGrant:
    with service.transaction(db):
        row = _category(db, actor, category_id, write=True)
        return _put(
            db,
            actor,
            row,
            subject,
            subject_id,
            payload.level,
            if_match,
            response,
            _path(row, subject, subject_id),
        )


@router.delete("/categories/{category_id}/access-grants/{subject}/{subject_id}", status_code=204)
def delete_category_grant(
    category_id: UUID,
    subject: SubjectPath,
    subject_id: UUID,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> None:
    with service.transaction(db):
        row = _category(db, actor, category_id, write=True)
        _delete(db, actor, row, subject, subject_id, if_match, response)


@router.get("/categories/{category_id}/access-candidates", response_model=AccessCandidates)
def list_category_candidates(
    category_id: UUID,
    query: Annotated[AccessCandidateQuery, Query()],
    db: DB,
    actor: Actor,
    response: Response,
) -> AccessCandidates:
    _category(db, actor, category_id, write=False)
    service.private(response)
    return _candidates(db, query)
