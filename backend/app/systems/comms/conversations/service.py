"""Shared structure invariants: current policy, resource locks and configuration validators."""

import json
from collections.abc import Collection, Iterator
from contextlib import contextmanager
from hashlib import sha256
from typing import Any
from uuid import UUID

from fastapi import Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.models import Group
from app.systems.access.policy.readers import active_account_clause
from app.systems.access.users.membership import bound_membership_join, bound_organization
from app.systems.access.users.models import Membership, User
from app.systems.comms.access import error, require_conversation_access
from app.systems.comms.capabilities import (
    capability_check,
    channel_creation_check,
    scope_management_decision,
)
from app.systems.comms.conversations.models import (
    CommsCategory,
    CommsConversation,
    CommsConversationGroup,
    CommsMember,
)
from app.systems.comms.messages.schemas import EveryoneAccess, GroupAccess
from app.systems.comms.settings.models import CommsCapabilityGrant, CommsSettings
from app.systems.comms.settings.resolution import Scope
from app.systems.sandbox.departments.models import Department


@contextmanager
def transaction(db: Session) -> Iterator[None]:
    try:
        yield
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise error("comms_conflict", "Structure changed; reload and try again", 409) from exc
    except SQLAlchemyError as exc:
        db.rollback()
        raise error("comms_unavailable", "Structure operation unavailable", 503) from exc
    except Exception:
        db.rollback()
        raise


def creation_scope(category_id: UUID | None) -> Scope:
    return {"kind": "category", "id": category_id} if category_id else {"kind": "workspace"}


def require_creation(db: Session, user: User, category_id: UUID | None) -> None:
    if not channel_creation_check(db, user, creation_scope(category_id))["decision"]["allowed"]:
        raise error("comms_capability_denied", "Channel creation is not permitted", 403)


def require_management(db: Session, user: User, scope: Scope) -> None:
    if not scope_management_decision(db, user, scope)["allowed"]:
        raise error("comms_capability_denied", "Configuration change is not permitted", 403)


def category(db: Session, identity: UUID, *, lock: bool = False) -> CommsCategory:
    query = (
        select(CommsCategory)
        .where(
            CommsCategory.org_id == bound_organization_column(),
            CommsCategory.id == identity,
            CommsCategory.is_deleted.is_(False),
            CommsCategory.deleted_at.is_(None),
        )
        .execution_options(populate_existing=True)
    )
    row = db.scalar(query.with_for_update() if lock else query)
    if row is None:
        raise error("comms_not_found", "Category not found")
    return row


def manage_conversation(db: Session, user: User, identity: UUID) -> CommsConversation:
    # Lock first, then refresh authorization and the token after any wait.
    row = db.scalar(
        select(CommsConversation)
        .where(
            CommsConversation.org_id == bound_organization_column(),
            CommsConversation.id == identity,
            CommsConversation.is_deleted.is_(False),
            CommsConversation.deleted_at.is_(None),
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    require_conversation_access(db, user, identity, "read")
    if row is None:
        raise error("comms_not_found", "Conversation not found")
    if not capability_check(db, user, identity)["capabilities"]["manageChannel"]["allowed"]:
        raise error("comms_capability_denied", "Conversation management is not permitted", 403)
    return row


def require_channel(row: CommsConversation) -> None:
    if row.kind != "channel":
        raise error("comms_invalid", "A channel is required", 422)


def require_department(db: Session, identity: UUID | None) -> None:
    if (
        identity is not None
        and db.scalar(
            select(Department.id).where(
                Department.org_id == bound_organization_column(),
                Department.id == identity,
                Department.is_deleted.is_(False),
            )
        )
        is None
    ):
        raise error("comms_not_found", "Department not found")


def require_people(db: Session, identities: Collection[UUID]) -> None:
    if set(
        db.scalars(
            select(User.id)
            .join(
                # Membership joins always carry the bound org, even with an explicit candidate set.
                Membership,
                bound_membership_join(),
            )
            .where(User.id.in_(identities), active_account_clause())
        )
    ) != set(identities):
        raise error("comms_not_found", "Person not found")


def validate_access(db: Session, rows: list[EveryoneAccess | GroupAccess]) -> None:
    keys = [(row.subject, row.group_id if isinstance(row, GroupAccess) else None) for row in rows]
    ids = {row.group_id for row in rows if isinstance(row, GroupAccess)}
    if (
        len(set(keys)) != len(keys)
        or set(
            db.scalars(
                select(Group.id).where(
                    Group.org_id == bound_organization_column(),
                    Group.is_deleted.is_(False),
                    Group.id.in_(ids),
                )
            )
        )
        != ids
    ):
        raise error("comms_invalid", "Invalid access groups", 422)


def replace_access(
    db: Session,
    owner: CommsCategory | CommsConversation,
    rows: list[EveryoneAccess | GroupAccess],
) -> None:
    validate_access(db, rows)
    field = "category_id" if isinstance(owner, CommsCategory) else "conversation_id"
    existing = db.scalars(
        select(CommsConversationGroup).where(
            CommsConversationGroup.org_id == bound_organization_column(),
            getattr(CommsConversationGroup, field) == owner.id,
        )
    ).all()
    for row in existing:
        db.delete(row)
    db.flush()
    for grant in rows:
        db.add(
            CommsConversationGroup(
                org_id=bound_organization(db),
                **{field: owner.id},
                **grant.model_dump(),
            )
        )


def version(db: Session, row: CommsCategory | CommsConversation) -> str:
    """Actor-independent configuration token, excluding messages and personal state."""
    db.flush()
    payload: dict[str, Any] = {
        "resource": {column.name: getattr(row, column.name) for column in row.__table__.columns},
    }
    field = "category_id" if isinstance(row, CommsCategory) else "conversation_id"
    models: tuple[
        type[CommsConversationGroup | CommsSettings | CommsCapabilityGrant | CommsMember], ...
    ] = (
        CommsConversationGroup,
        CommsSettings,
        CommsCapabilityGrant,
    )
    if isinstance(row, CommsConversation):
        models += (CommsMember,)
    for model in models:
        payload[model.__tablename__] = [
            dict(item)
            for item in db.execute(
                select(model.__table__)
                .where(
                    model.org_id == bound_organization_column(),
                    getattr(model, field) == row.id,
                )
                .order_by(model.id)
            ).mappings()
        ]
    return '"' + sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest() + '"'


def match(db: Session, row: CommsCategory | CommsConversation, value: str | None) -> None:
    if value is None:
        raise error("comms_precondition_required", "If-Match is required", 428)
    if value != version(db, row):
        raise error("comms_precondition_failed", "Resource changed", 412)


def private(response: Response) -> None:
    response.headers["Cache-Control"] = "private, no-store"


def headers(db: Session, response: Response, row: CommsCategory | CommsConversation) -> None:
    private(response)
    response.headers["ETag"] = version(db, row)
