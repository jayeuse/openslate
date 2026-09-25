"""Shared fixture builders for workspace policy authorization integration tests."""

from dataclasses import dataclass
from uuid import UUID

from app.systems.access.users.models import IdentityKind, Role, User, UserStatus


@dataclass(frozen=True, slots=True)
class ConcurrencyRows:
    database_url: str
    reader_role_id: UUID
    first_user_id: UUID
    second_user_id: UUID
    admin_user_id: UUID
    admin_role_id: UUID
    first_session_id: UUID
    second_session_id: UUID
    group_id: UUID
    membership_id: UUID


@dataclass(frozen=True, slots=True)
class ServiceCheckRows:
    database_url: str
    role_id: UUID
    owner_id: UUID
    service_id: UUID
    service_etag: str


def _role(*, name: str, permissions: dict[str, bool]) -> Role:
    return Role(role=name, description="", permissions=permissions)


def _user(*, role: Role, name: str) -> User:
    return User(
        email=f"{name}@example.test",
        username=name,
        identity_kind=IdentityKind.INTERNAL.value,
        status=UserStatus.ACTIVE.value,
        role_id=role.id,
    )
