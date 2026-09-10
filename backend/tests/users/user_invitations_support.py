from unittest.mock import Mock

from uuid6 import uuid7

from app.core.integrations.supabase import SupabaseAdminClient, SupabaseAuthUser
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import Role, User, UserRole, UserStatus


def role(name: str = UserRole.MEMBER, *, deleted: bool = False) -> Role:
    result = Role(role=name, permissions={}, is_deleted=deleted)
    result.id = uuid7()
    return result


def profile(user_id, assigned_role: Role, *, status: str = UserStatus.PENDING.value) -> User:
    return User(
        id=user_id,
        email="invited@example.com",
        username=f"auth_{user_id.hex}",
        status=status,
        role_id=assigned_role.id,
        role=assigned_role,
        is_deleted=False,
    )


def invitation(role_id=None) -> InvitationCreate:
    return InvitationCreate(
        email=" Invited@Example.com ",
        username=" New_User ",
        role_id=role_id,
    )


def auth_client(auth_id=None) -> Mock:
    client = Mock(spec=SupabaseAdminClient)
    client.invite_user.return_value = SupabaseAuthUser(auth_id or uuid7(), "invited@example.com")
    return client
