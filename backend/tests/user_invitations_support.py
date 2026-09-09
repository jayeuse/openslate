from unittest.mock import Mock

from uuid6 import uuid7

from app.core.integrations.supabase import SupabaseAdminClient, SupabaseAuthUser
from app.systems.auth.schemas import InvitationCreate
from app.systems.users.models import Role, User, UserRole, UserStatus
from app.systems.users.service import invite_user as invite_user_service


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
    client.invite_user.return_value = SupabaseAuthUser(
        auth_id or uuid7(), "invited@example.com"
    )
    return client


def invite_user(db: Mock, payload: InvitationCreate, *, client: Mock) -> User:
    admin_role = role(UserRole.ADMIN)
    admin = profile(uuid7(), admin_role, status=UserStatus.ACTIVE.value)
    side_effect = db.scalar.side_effect
    if side_effect is not None:
        existing_values = list(side_effect)
        values = [admin_role, admin, *existing_values]
        if len(existing_values) >= 2 and existing_values[1] is None:
            values = [
                admin_role,
                admin,
                existing_values[0],
                existing_values[1],
                admin_role,
                admin,
                *existing_values[2:],
            ]
        db.scalar.side_effect = values
    else:
        db.scalar.side_effect = [admin_role, admin, db.scalar.return_value]
    return invite_user_service(db, payload, client=client, actor_id=admin.id)
