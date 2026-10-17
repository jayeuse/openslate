"""Organization listing for background workers that serve every organization."""

from uuid import UUID

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.systems.manage.workspace.models import WorkspaceProfile


def active_organization_ids(engine: Engine) -> list[UUID]:
    """Every live organization, in a stable order, for one worker pass each."""

    with Session(engine) as db:
        return list(db.scalars(
            select(WorkspaceProfile.id)
            .where(WorkspaceProfile.is_deleted.is_(False))
            .order_by(WorkspaceProfile.id)
        ))
