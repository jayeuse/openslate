"""A transient local profile for user-administration unit tests."""

from datetime import UTC, datetime, timedelta

from uuid6 import uuid7

from app.systems.access.users.models import Membership, User, UserRole, UserStatus
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member


def local_user(
    role: UserRole = UserRole.MEMBER,
    *,
    status: UserStatus = UserStatus.ACTIVE,
    deleted: bool = False,
) -> tuple[User, Membership]:
    now = datetime.now(UTC)
    guest = role is UserRole.GUEST
    user, membership = create_member(
        None, WorkspaceProfile(id=uuid7()), role.value,
        id=uuid7(),
        email=f"{uuid7().hex}@example.com",
        username=f"user_{uuid7().hex[-12:]}",
        status=status.value,
        sponsor_user_id=uuid7() if guest else None,
        expires_at=now + timedelta(days=30) if guest else None,
        created_at=now,
        updated_at=now,
        is_deleted=deleted,
        deleted_at=now if deleted else None,
    )
    membership.is_deleted = False
    return user, membership
