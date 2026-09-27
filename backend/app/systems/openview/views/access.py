from sqlalchemy import and_, false, or_
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User, UserStatus
from app.systems.openview.views.models import AudienceKind, SavedView


def visible_to(db: Session, user: User) -> ColumnElement[bool]:
    """A view needs read on its module, then owner, everyone or user audience access."""

    if user.status != UserStatus.ACTIVE or user.is_deleted:
        return false()
    return and_(
        module_filter(db, user, AccessLevel.READ, SavedView.module_id),
        or_(
            SavedView.owner_id == user.id,
            and_(
                SavedView.is_deleted.is_(False),
                or_(
                    SavedView.audience_kind == AudienceKind.EVERYONE,
                    and_(
                        SavedView.audience_kind == AudienceKind.USER,
                        SavedView.audience_user_id == user.id,
                    ),
                ),
            ),
        ),
    )
