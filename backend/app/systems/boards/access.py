"""Fail-closed Board access evaluation."""

from collections.abc import Iterable
from uuid import UUID

from app.systems.access.identity.eligibility import is_identity_eligible
from app.systems.access.users.eligibility import is_established_user
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.boards.models import (
    Board,
    BoardGrant,
    BoardGrantEffect,
    BoardPermission,
    BoardPrincipalType,
)

_PRINCIPAL_PRIORITY = {
    BoardPrincipalType.EVERYONE: 1,
    BoardPrincipalType.USER: 2,
}
_MISSING = object()
_IMPLIED_PERMISSIONS = {
    BoardPermission.VIEW: frozenset(BoardPermission),
    BoardPermission.EDIT: frozenset({BoardPermission.EDIT, BoardPermission.MANAGE}),
    BoardPermission.MANAGE: frozenset({BoardPermission.MANAGE}),
}


def _active_entity(value: object) -> bool:
    return (
        getattr(value, "is_deleted", None) is False
        and getattr(value, "deleted_at", _MISSING) is None
    )


def _active_actor(actor: User | None) -> str | None:
    """Return the role of an active, accepted, unexpired actor, else None."""

    if actor is None or not _active_entity(actor) or not is_identity_eligible(actor):
        return None
    role = getattr(actor, "role", None)
    if (
        role not in {item.value for item in UserRole}
        or getattr(actor, "status", None) != UserStatus.ACTIVE.value
        or not is_established_user(actor)
        or not isinstance(getattr(actor, "id", None), UUID)
    ):
        return None
    return str(role)


def _principal_priority(grant: BoardGrant, actor: User, board_id: UUID) -> int | None:
    if getattr(grant, "board_id", None) != board_id or not _active_entity(grant):
        return None

    raw_type = getattr(grant, "principal_type", None)
    if not isinstance(raw_type, str):
        return None
    try:
        principal_type = BoardPrincipalType(raw_type)
    except ValueError:
        return None

    user_id = getattr(grant, "principal_user_id", None)
    if principal_type is BoardPrincipalType.USER:
        if not isinstance(user_id, UUID) or user_id != actor.id:
            return None
    elif user_id is not None:
        return None

    return _PRINCIPAL_PRIORITY[principal_type]


def can_access_board(
    board: Board | None,
    actor: User | None,
    action: str | BoardPermission,
    grants: Iterable[BoardGrant],
) -> bool:
    """Check the account gate and the Board's most-specific ACL rules.

    Any active account may view; a guest may not edit or manage. View grants are
    required for reads; edit/manage grants are required for mutations. Active
    creators and admins retain Board authority after the account gate. For other
    principals, higher Board permissions imply lower ones; explicit view denial
    also denies edit and manage. User grants outrank everyone grants, while deny
    wins among decisions at the same priority.
    """

    if board is None or actor is None or not _active_entity(board):
        return False
    board_id = getattr(board, "id", None)
    if not isinstance(board_id, UUID):
        return False

    try:
        requested = BoardPermission(action)
    except (TypeError, ValueError):
        return False

    role = _active_actor(actor)
    if role is None:
        return False
    if requested is not BoardPermission.VIEW and role == UserRole.GUEST.value:
        return False
    return _board_permission_granted(board, actor, role, requested, grants)


def can_read_board_grants(
    board: Board | None,
    actor: User | None,
    grants: Iterable[BoardGrant],
) -> bool:
    """Allow an active account to inspect grants only when it manages the Board.

    Listing access rules is a read operation. Mutations continue to use
    :func:`can_access_board` with ``manage``, which a guest never passes.
    """

    if board is None or actor is None or not _active_entity(board):
        return False
    if not isinstance(getattr(board, "id", None), UUID):
        return False
    role = _active_actor(actor)
    if role is None:
        return False
    return _board_permission_granted(board, actor, role, BoardPermission.MANAGE, grants)


def _board_permission_granted(
    board: Board,
    actor: User,
    role: str,
    requested: BoardPermission,
    grants: Iterable[BoardGrant],
) -> bool:
    board_id = getattr(board, "id", None)
    if not isinstance(board_id, UUID):
        return False
    if getattr(board, "owner_id", None) == actor.id or role == UserRole.ADMIN.value:
        return True

    matching: list[tuple[int, BoardPermission, BoardGrantEffect]] = []
    for grant in grants:
        priority = _principal_priority(grant, actor, board_id)
        if priority is None:
            continue
        raw_permission = getattr(grant, "permission", None)
        raw_effect = getattr(grant, "effect", None)
        if not isinstance(raw_permission, str) or not isinstance(raw_effect, str):
            continue
        try:
            permission = BoardPermission(raw_permission)
            effect = BoardGrantEffect(raw_effect)
        except ValueError:
            continue
        matching.append((priority, permission, effect))

    allowed_permissions = _IMPLIED_PERMISSIONS[requested]
    denied_permissions = {requested}
    if requested is not BoardPermission.VIEW:
        denied_permissions.add(BoardPermission.VIEW)

    decisions = [
        (priority, effect)
        for priority, permission, effect in matching
        if (effect is BoardGrantEffect.ALLOW and permission in allowed_permissions)
        or (effect is BoardGrantEffect.DENY and permission in denied_permissions)
    ]
    if not decisions:
        return False

    highest_priority = max(priority for priority, _ in decisions)
    highest_priority_effects = {
        effect for priority, effect in decisions if priority == highest_priority
    }
    return (
        BoardGrantEffect.ALLOW in highest_priority_effects
        and BoardGrantEffect.DENY not in highest_priority_effects
    )
