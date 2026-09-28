"""Who sees a saved view: every user who can read its module."""

from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.systems.access.policy.checks import module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.openview.views.models import SavedView


def visible_to(db: Session, user: User) -> ColumnElement[bool]:
    """A view is shared with every reader of its module. Only ``manage`` changes it.

    An inactive account reads nothing, because its effective levels are empty.
    """

    return module_filter(db, user, AccessLevel.READ, SavedView.module_id)
