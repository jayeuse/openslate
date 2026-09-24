"""Fail-closed Board access evaluation."""

from collections.abc import Iterable
from uuid import UUID

from app.systems.access.users.models import Role, User, UserRole, UserStatus
from app.systems.access.users.permissions import Capability, has_capability
from app.systems.boards.models import (
    Board,
    BoardGrant,
    BoardGrantEffect,
    BoardPermission,
    BoardPrincipalType,
)

_PRINCIPAL_PRIORITY = {
    BoardPrincipalType.EVERYONE: 1,
    BoardPrincipalType.ROLE: 2,
    BoardPrincipalType.USER: 3,
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


def _active_actor(actor: User | None) -> Role | None:
    if actor is None or not _active_entity(actor):
        return None
    role = getattr(actor, "role", None)
    actor_id = getattr(actor, "id", None)
    role_id = getattr(actor, "role_id", None)
    if (
        not isinstance(role, Role)
        or not _active_entity(role)
        or getattr(actor, "status", None) != UserStatus.ACTIVE.value
        or not isinstance(actor_id, UUID)
        or not isinstance(role_id, UUID)
        or getattr(role, "id", None) != role_id
    ):
        return None
    return role


def _principal_priority(grant: BoardGrant, actor: User, role: Role, board_id: UUID) -> int | None:
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
    role_id = getattr(grant, "principal_role_id", None)
    if principal_type is BoardPrincipalType.USER:
        if role_id is not None or not isinstance(user_id, UUID) or user_id != actor.id:
            return None
    elif principal_type is BoardPrincipalType.ROLE:
        if user_id is not None or not isinstance(role_id, UUID) or role_id != role.id:
            return None
    elif user_id is not None or role_id is not None:
        return None

    return _PRINCIPAL_PRIORITY[principal_type]


def can_access_board(
    board: Board | None,
    actor: User | None,
    action: str | BoardPermission,
    grants: Iterable[BoardGrant],
) -> bool:
    """Check the global record gate and the Board's most-specific ACL rules.

    View grants are required for reads; edit/manage grants are required for
    mutations. Active creators and admins retain Board authority after the
    global capability gate. For other principals, higher Board permissions
    imply lower ones; explicit view denial also denies edit and manage.
    Identity grants outrank role and everyone grants, while deny wins among
    decisions at the same priority.
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
    required_capability = (
        Capability.RECORDS_READ if requested is BoardPermission.VIEW else Capability.RECORDS_WRITE
    )
    if not has_capability(role, required_capability):
        return False
    return _board_permission_granted(board, actor, role, requested, grants)


def can_read_board_grants(
    board: Board | None,
    actor: User | None,
    grants: Iterable[BoardGrant],
) -> bool:
    """Allow a global reader to inspect grants only when they manage the Board.

    Listing access rules is a read operation and does not require the global
    records.write capability. Mutations continue to use :func:`can_access_board`
    with ``manage``, which does require records.write.
    """

    if board is None or actor is None or not _active_entity(board):
        return False
    if not isinstance(getattr(board, "id", None), UUID):
        return False
    role = _active_actor(actor)
    if role is None or not has_capability(role, Capability.RECORDS_READ):
        return False
    return _board_permission_granted(board, actor, role, BoardPermission.MANAGE, grants)


def _board_permission_granted(
    board: Board,
    actor: User,
    role: Role,
    requested: BoardPermission,
    grants: Iterable[BoardGrant],
) -> bool:
    board_id = getattr(board, "id", None)
    if not isinstance(board_id, UUID):
        return False
    if getattr(board, "owner_id", None) == actor.id or role.role == UserRole.ADMIN.value:
        return True

    matching: list[tuple[int, BoardPermission, BoardGrantEffect]] = []
    for grant in grants:
        priority = _principal_priority(grant, actor, role, board_id)
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
