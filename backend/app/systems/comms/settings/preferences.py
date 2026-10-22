"""Only the bound actor owns these rows; preference writes ignore If-Match entirely."""

from hashlib import sha256
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core.database.organization_scope import bound_organization_column
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import error, fresh_membership, require_conversation_access
from app.systems.comms.conversations.service import (
    private,
    require_visible_category,
    transaction,
)
from app.systems.comms.messages.schemas import CategoryPreferences, MemberPreferences
from app.systems.comms.realtime.events import user_event
from app.systems.comms.settings.models import CommsMemberPreferences, CommsPersonalPreferences
from app.systems.comms.settings.schemas import (
    CategoryPreferencesRequest,
    MemberPreferencesPatch,
    PersonalPreferences,
    personal_defaults,
)

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
router = APIRouter(prefix="/comms", tags=["comms"], dependencies=[Depends(get_current_membership)])
VERSIONED: dict[int | str, dict[str, Any]] = {
    200: {
        "headers": {
            "ETag": {
                "schema": {"type": "string"},
                "description": "Response metadata only; preference writes are last-write-wins",
            }
        }
    }
}


def _version(
    response: Response, value: PersonalPreferences | MemberPreferences | CategoryPreferences
) -> None:
    private(response)
    serialized = value.model_dump_json(exclude_unset=isinstance(value, PersonalPreferences))
    response.headers["ETag"] = '"' + sha256(serialized.encode()).hexdigest() + '"'


def _lock_actor(db: Session, actor: User) -> None:
    db.scalar(
        select(Membership)
        .where(Membership.org_id == bound_organization_column(), Membership.user_id == actor.id)
        .with_for_update()
    )
    if fresh_membership(db, actor) is None:
        raise error("comms_not_found", "Person not found")


def _personal(db: Session, actor: User) -> CommsPersonalPreferences | None:
    return db.scalar(
        select(CommsPersonalPreferences)
        .where(
            CommsPersonalPreferences.org_id == bound_organization_column(),
            CommsPersonalPreferences.user_id == actor.id,
        )
        .execution_options(populate_existing=True)
    )


def _member(
    db: Session, actor: User, identity: UUID, *, is_category: bool = False, lock: bool = False
) -> CommsMemberPreferences | None:
    query = (
        select(CommsMemberPreferences)
        .where(
            CommsMemberPreferences.org_id == bound_organization_column(),
            CommsMemberPreferences.user_id == actor.id,
            CommsMemberPreferences.category_id == (identity if is_category else None),
            CommsMemberPreferences.conversation_id == (None if is_category else identity),
        )
        .execution_options(populate_existing=True)
    )
    return db.scalar(query.with_for_update() if lock else query)


def _project(
    row: CommsMemberPreferences | None, *, is_category: bool = False
) -> MemberPreferences | CategoryPreferences:
    if row is None or row.is_deleted:
        return CategoryPreferences() if is_category else MemberPreferences()
    mute = {"kind": row.mute, **({"until": row.muted_until} if row.mute == "until" else {})}
    if is_category:
        return CategoryPreferences.model_validate({"collapsed": row.collapsed, "mute": mute})
    return MemberPreferences.model_validate(
        {
            "notify": row.notify,
            "mute": mute,
            "starred": row.starred,
            "hidden": row.hidden,
            "manual_unread": row.manual_unread,
        }
    )


@router.get(
    "/preferences",
    response_model=PersonalPreferences,
    response_model_exclude_unset=True,
    responses=VERSIONED,
)
def get_personal(db: DB, actor: Actor, response: Response) -> PersonalPreferences:
    row = _personal(db, actor)
    value = (
        personal_defaults()
        if row is None or row.is_deleted
        else PersonalPreferences.model_validate(row.values)
    )
    _version(response, value)
    return value


@router.put(
    "/preferences",
    response_model=PersonalPreferences,
    response_model_exclude_unset=True,
    responses=VERSIONED,
)
def put_personal(
    payload: PersonalPreferences, db: DB, actor: Actor, response: Response
) -> PersonalPreferences:
    with transaction(db):
        _lock_actor(db, actor)
        row = _personal(db, actor)
        if row is None:
            row = CommsPersonalPreferences(org_id=bound_organization(db), user_id=actor.id)
            db.add(row)
        row.values, row.is_deleted, row.deleted_at = (
            payload.model_dump(mode="json", exclude_unset=True),
            False,
            None,
        )
        _version(response, payload)
        user_event(db, actor.id, "structure", {})
    return payload


@router.get(
    "/conversations/{conversation_id}/preferences",
    response_model=MemberPreferences,
    responses=VERSIONED,
)
def get_member(
    conversation_id: UUID, db: DB, actor: Actor, response: Response
) -> MemberPreferences | CategoryPreferences:
    require_conversation_access(db, actor, conversation_id, "read")
    value = _project(_member(db, actor, conversation_id))
    _version(response, value)
    return value


@router.patch(
    "/conversations/{conversation_id}/preferences",
    response_model=MemberPreferences,
    responses=VERSIONED,
)
def patch_member(
    conversation_id: UUID, payload: MemberPreferencesPatch, db: DB, actor: Actor, response: Response
) -> MemberPreferences | CategoryPreferences:
    with transaction(db):
        _lock_actor(db, actor)
        require_conversation_access(db, actor, conversation_id, "read")
        row = _member(db, actor, conversation_id, lock=True)
        values = {**_project(row).model_dump(), **payload.model_dump(exclude_unset=True)}
        if row is None:
            row = CommsMemberPreferences(
                org_id=bound_organization(db),
                user_id=actor.id,
                conversation_id=conversation_id,
                collapsed=None,
            )
            db.add(row)
        row.is_deleted, row.deleted_at = False, None
        row.notify, row.starred = values["notify"], values["starred"]
        row.hidden, row.manual_unread = values["hidden"], values["manual_unread"]
        row.mute, row.muted_until = values["mute"]["kind"], values["mute"].get("until")
        value = _project(row)
        _version(response, value)
        user_event(db, actor.id, "membership", {"conversation_id": str(conversation_id)})
    return value


@router.get(
    "/categories/{category_id}/preferences", response_model=CategoryPreferences, responses=VERSIONED
)
def get_category(
    category_id: UUID, db: DB, actor: Actor, response: Response
) -> MemberPreferences | CategoryPreferences:
    require_visible_category(db, actor, category_id)
    value = _project(_member(db, actor, category_id, is_category=True), is_category=True)
    _version(response, value)
    return value


@router.put(
    "/categories/{category_id}/preferences", response_model=CategoryPreferences, responses=VERSIONED
)
def put_category(
    category_id: UUID, payload: CategoryPreferencesRequest, db: DB, actor: Actor, response: Response
) -> MemberPreferences | CategoryPreferences:
    with transaction(db):
        _lock_actor(db, actor)
        require_visible_category(db, actor, category_id)
        row = _member(db, actor, category_id, is_category=True, lock=True)
        if row is None:
            row = CommsMemberPreferences(
                org_id=bound_organization(db),
                user_id=actor.id,
                category_id=category_id,
                notify=None,
                starred=None,
                hidden=None,
                manual_unread=None,
            )
            db.add(row)
        row.is_deleted, row.deleted_at, row.collapsed = False, None, payload.collapsed
        mute = payload.mute.model_dump()
        row.mute, row.muted_until = mute["kind"], mute.get("until")
        value = _project(row, is_category=True)
        _version(response, value)
        user_event(db, actor.id, "structure", {})
    return value
