"""Atomic configuration writes; shared mutations lock one resource, never an organization."""

from typing import Any
from uuid import UUID

from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.membership import bound_organization, organization_membership
from app.systems.access.users.models import User
from app.systems.comms.access import (
    conversation_reader_statement,
    error,
    explain_conversation_access,
)
from app.systems.comms.conversations.models import (
    CommsCategory,
    CommsConversation,
    CommsMember,
)
from app.systems.comms.conversations.schemas import (
    CategoryRequest,
    ChannelPatch,
    ChannelRequest,
    DepartmentChannelRequest,
    DuplicateRequest,
)
from app.systems.comms.conversations.service import (
    require_category_binding,
    require_channel,
    require_creation,
    require_department,
    require_people,
)
from app.systems.comms.messages.models import CommsConversationCounter
from app.systems.comms.realtime.models import CommsRealtimeGrant
from app.systems.comms.settings.models import CommsCapabilityGrant, CommsSettings
from app.systems.comms.settings.resolution import locked_keys


def stage_conversation(
    db: Session,
    user: User,
    *,
    people: set[UUID],
    **fields: Any,
) -> CommsConversation:
    require_people(db, people)
    row = CommsConversation(org_id=bound_organization(db), created_by=user.id, **fields)
    db.add(row)
    db.flush()
    db.add(CommsConversationCounter(org_id=row.org_id, conversation_id=row.id, last_seq=0))
    for identity in sorted(people):
        db.add(
            CommsMember(org_id=row.org_id, conversation_id=row.id, user_id=identity, role="member")
        )
    db.flush()
    return row


def create_channel(db: Session, user: User, payload: ChannelRequest) -> CommsConversation:
    department = payload.department_id if isinstance(payload, DepartmentChannelRequest) else None
    require_creation(db, user, payload.category_id, department)
    require_department(db, department)
    require_category_binding(db, payload.category_id, department)
    # D44: the creator's row makes them a manager; everyone else reads by scope.
    row = stage_conversation(
        db,
        user,
        people={user.id},
        kind="channel",
        scope=payload.scope,
        name=payload.name,
        topic=payload.topic,
        category_id=payload.category_id,
        position=payload.position,
        department_id=department,
    )
    return row


def create_category(db: Session, user: User, payload: CategoryRequest) -> CommsCategory:
    require_creation(db, user, None, channel=False)
    require_department(db, payload.department_id)
    row = CommsCategory(org_id=bound_organization(db), **payload.model_dump())
    db.add(row)
    db.flush()
    return row


def update_category(db: Session, row: CommsCategory, payload: CategoryRequest) -> None:
    require_department(db, payload.department_id)
    # D44 A8: a category's channels keep matching its department; rebinding must not break that.
    if payload.department_id != row.department_id and db.scalar(
        select(
            exists().where(
                CommsConversation.org_id == bound_organization_column(),
                CommsConversation.category_id == row.id,
                CommsConversation.kind == "channel",
                CommsConversation.is_deleted.is_(False),
                CommsConversation.deleted_at.is_(None),
                CommsConversation.department_id.is_distinct_from(payload.department_id),
            )
        )
    ):
        raise error("comms_invalid", "The category's channels belong to another department", 422)
    for name, value in payload.model_dump().items():
        setattr(row, name, value)
    row.updated_at = utc_now()


def update_channel(db: Session, row: CommsConversation, payload: ChannelPatch) -> None:
    require_channel(row)
    if payload.category_id is not None:
        require_category_binding(db, payload.category_id, row.department_id)
    for name, value in payload.model_dump(exclude_unset=True).items():
        setattr(row, name, value)
    row.updated_at = utc_now()


def retain_read(db: Session, user: User, row: CommsConversation) -> None:
    if explain_conversation_access(db, user, row.id).level == "none":
        raise error(
            "comms_conflict",
            "This change would remove your read access. No changes were saved.",
            409,
        )


def _live_member(db: Session, row: CommsConversation, identity: UUID) -> CommsMember | None:
    return db.scalar(
        select(CommsMember)
        .where(
            CommsMember.org_id == bound_organization_column(),
            CommsMember.conversation_id == row.id,
            CommsMember.user_id == identity,
            CommsMember.is_deleted.is_(False),
            CommsMember.deleted_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )


def member(db: Session, row: CommsConversation, identity: UUID) -> CommsMember:
    if row.kind == "direct":
        raise error("comms_invalid", "Direct participants cannot be changed", 422)
    result = _live_member(db, row, identity)
    if result is None:
        raise error("comms_not_found", "Member not found")
    return result


def _require_manager_candidate(db: Session, identity: UUID) -> None:
    membership = organization_membership(db, identity, fresh=True)
    if membership is None or membership.role == "guest":
        raise error("comms_capability_denied", "Guest management is not permitted", 403)


def _set_channel_role(db: Session, row: CommsConversation, identity: UUID, role: str) -> None:
    """D44: a channel row marks the creator or a manager; only a current reader gets one."""
    require_people(db, [identity])
    current = select(CommsConversation.id).where(CommsConversation.id == row.id)
    if db.scalar(conversation_reader_statement(current, [identity])) is None:
        raise error("comms_not_found", "Member not found")
    target = _live_member(db, row, identity)
    if role == "manager":
        _require_manager_candidate(db, identity)
        if target is None:
            db.add(
                CommsMember(
                    org_id=row.org_id, conversation_id=row.id, user_id=identity, role="manager"
                )
            )
        else:
            target.role = "manager"
    elif target is not None:
        _drop_channel_manager(row, target)


def _drop_channel_manager(row: CommsConversation, target: CommsMember) -> None:
    # The creator's row stays (it is the creator source); any other row only marks a manager.
    if target.user_id == row.created_by:
        target.role = "member"
    else:
        target.is_deleted, target.deleted_at = True, utc_now()


def set_member_role(db: Session, row: CommsConversation, identity: UUID, role: str) -> None:
    if row.kind == "channel":
        _set_channel_role(db, row, identity, role)
    else:
        target = member(db, row, identity)
        require_people(db, [identity])
        if role == "manager":
            _require_manager_candidate(db, identity)
        target.role = role
    row.updated_at = utc_now()


def remove_member(db: Session, row: CommsConversation, identity: UUID) -> None:
    if row.kind == "channel":
        target = _live_member(db, row, identity)
        # D44: DELETE removes a manager row only; readers stay readers by scope.
        if target is None or target.role != "manager":
            raise error("comms_not_found", "Member not found")
        _drop_channel_manager(row, target)
        row.updated_at = utc_now()
        return
    target = member(db, row, identity)
    count = db.scalar(
        select(func.count())
        .select_from(CommsMember)
        .where(
            CommsMember.org_id == bound_organization_column(),
            CommsMember.conversation_id == row.id,
            CommsMember.is_deleted.is_(False),
            CommsMember.deleted_at.is_(None),
        )
    )
    if row.kind == "group" and (count or 0) <= 3:
        raise error("comms_conflict", "Group requires at least three participants", 409)
    target.is_deleted, target.deleted_at = True, utc_now()
    for grant in db.scalars(
        select(CommsRealtimeGrant).where(
            CommsRealtimeGrant.org_id == bound_organization_column(),
            CommsRealtimeGrant.conversation_id == row.id,
            CommsRealtimeGrant.user_id == identity,
        )
    ):
        db.delete(grant)
    row.updated_at = utc_now()


def duplicate(
    db: Session,
    user: User,
    source: CommsConversation,
    payload: DuplicateRequest,
) -> CommsConversation:
    require_channel(source)
    require_creation(db, user, payload.category_id, source.department_id)
    require_category_binding(db, payload.category_id, source.department_id)
    # Copy scope and configuration, never member rows, manager roles or content.
    row = stage_conversation(
        db,
        user,
        people={user.id},
        kind="channel",
        scope=source.scope,
        category_id=payload.category_id,
        department_id=source.department_id,
        name=payload.name,
        topic=source.topic,
        position=source.position,
    )
    require_department(db, source.department_id)
    settings_locks, capability_locks = locked_keys(db, "setting"), locked_keys(db, "capability")
    for old_settings in db.scalars(
        select(CommsSettings).where(
            CommsSettings.org_id == bound_organization_column(),
            CommsSettings.conversation_id == source.id,
            CommsSettings.is_deleted.is_(False),
        )
    ):
        values = {
            key: value for key, value in old_settings.values.items() if key not in settings_locks
        }
        db.add(
            CommsSettings(org_id=row.org_id, scope="channel", conversation_id=row.id, values=values)
        )
    for grant in db.scalars(
        select(CommsCapabilityGrant).where(
            CommsCapabilityGrant.org_id == bound_organization_column(),
            CommsCapabilityGrant.conversation_id == source.id,
            CommsCapabilityGrant.is_deleted.is_(False),
        )
    ):
        if grant.capability not in capability_locks:
            db.add(
                CommsCapabilityGrant(
                    org_id=row.org_id,
                    scope="channel",
                    conversation_id=row.id,
                    capability=grant.capability,
                    subject=grant.subject,
                    group_id=grant.group_id,
                    granted=grant.granted,
                )
            )
    return row
