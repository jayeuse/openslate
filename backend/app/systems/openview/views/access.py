from sqlalchemy import and_, exists, false, or_, select
from sqlalchemy.sql.elements import ColumnElement

from app.systems.access.users.models import Role, User, UserStatus
from app.systems.openview.views.models import AudienceKind, SavedView


def visible_to(user: User) -> ColumnElement[bool]:
    """Owner-only private access plus matching active audience access."""

    if user.status != UserStatus.ACTIVE or user.is_deleted or user.role.is_deleted:
        return false()
    role_is_active = exists(
        select(Role.id).where(
            Role.id == SavedView.audience_role_id,
            Role.is_deleted.is_(False),
        )
    )
    return or_(
        SavedView.owner_id == user.id,
        and_(
            SavedView.is_deleted.is_(False),
            or_(
                SavedView.audience_kind == AudienceKind.EVERYONE,
                and_(
                    SavedView.audience_kind == AudienceKind.ROLE,
                    SavedView.audience_role_id == user.role_id,
                    role_is_active,
                ),
                and_(
                    SavedView.audience_kind == AudienceKind.USER,
                    SavedView.audience_user_id == user.id,
                ),
            ),
        ),
    )
