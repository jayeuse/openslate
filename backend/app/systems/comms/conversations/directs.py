"""Private starts converge on the exact organization/pair uniqueness constraint."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import Membership, User
from app.systems.access.users.person_visibility import visible_person_ids
from app.systems.comms.access import (
    can_start_directs,
    error,
    fresh_membership,
    require_conversation_access,
)
from app.systems.comms.conversations.models import CommsConversation, CommsDirectBlock
from app.systems.comms.conversations.mutations import stage_conversation
from app.systems.comms.conversations.service import require_people


def admission(db: Session, user: User, ids: set[UUID]) -> None:
    require_people(db, ids)
    if not can_start_directs(db, user, ids):
        raise error("comms_post_denied", "Conversation access denied", 403)


def find_or_create(db: Session, user: User, target: UUID) -> tuple[CommsConversation, bool]:
    if target == user.id:
        raise error("comms_invalid", "Choose another person", 422)
    key = ":".join(sorted((str(user.id), str(target))))

    def existing() -> CommsConversation | None:
        return db.scalar(
            select(CommsConversation)
            .where(
                CommsConversation.org_id == bound_organization_column(),
                CommsConversation.kind == "direct",
                CommsConversation.direct_key == key,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    admission(db, user, {target})
    row = existing()
    if row is None:
        try:
            row = stage_conversation(
                db, user, people={user.id, target}, kind="direct", scope="members", direct_key=key
            )
            admission(db, user, {target})
            return row, True
        except IntegrityError as exc:
            # Only the exact lifetime pair collision is recoverable. Roll back the complete
            # losing attempt, then rebind/refresh current membership, visibility and policy.
            db.rollback()
            diagnostic = getattr(exc.orig, "diag", None)
            if getattr(diagnostic, "constraint_name", None) != "uq_comms_conversations_direct_key":
                raise
            row = existing()
    admission(db, user, {target})
    if row is None:
        raise error("comms_conflict", "Conversation changed; try again", 409)
    require_conversation_access(db, user, row.id, "read")
    return row, False


def create_group(db: Session, user: User, name: str, ids: list[UUID]) -> CommsConversation:
    if user.id not in ids:
        raise error("comms_invalid", "Participants must include the current actor", 422)
    admission(db, user, set(ids) - {user.id})
    row = stage_conversation(db, user, people=set(ids), kind="group", scope="members", name=name)
    admission(db, user, set(ids) - {user.id})
    return row


def toggle_block(db: Session, user: User, target: UUID, *, enabled: bool) -> bool:
    if target == user.id:
        raise error("comms_invalid", "Choose another person", 422)
    # Personal toggles serialize on the actor's bound membership, not an org-wide guard.
    db.scalar(
        select(Membership)
        .where(
            Membership.org_id == bound_organization_column(),
            Membership.user_id == user.id,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if fresh_membership(db, user) is None:
        raise error("comms_not_found", "Person not found")
    if enabled:
        require_people(db, [target])
        if target not in visible_person_ids(db, user, [target]):
            raise error("comms_not_found", "Person not found")
    row = db.scalar(
        select(CommsDirectBlock)
        .where(
            CommsDirectBlock.org_id == bound_organization_column(),
            CommsDirectBlock.user_id == user.id,
            CommsDirectBlock.blocked_user_id == target,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    changed = (enabled and (row is None or row.is_deleted)) or (not enabled and row is not None)
    if not enabled:
        if row is not None:
            db.delete(row)
    elif row is None:
        db.add(
            CommsDirectBlock(org_id=bound_organization(db), user_id=user.id, blocked_user_id=target)
        )
    elif row.is_deleted:
        row.is_deleted, row.deleted_at, row.created_at = False, None, utc_now()
    return changed
