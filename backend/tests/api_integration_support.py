from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.users.models import User
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member, create_organization, guarded_pooled_engine


def create_owned_admin(
    runtime_url: str, owner_url: str, prefix: str, *, org_id: UUID | None = None
) -> User:
    """An administrator of a new organization, or of ``org_id`` when it is given."""
    actor_id = uuid7()
    safe_prefix = (
        "".join(character if character.isalnum() else "_" for character in prefix).strip("_")
        or "test_actor"
    )
    email = f"{safe_prefix}-{actor_id}@example.com"
    username = f"{safe_prefix}_{actor_id.hex[:12]}"
    with Session(guarded_pooled_engine(owner_url)) as database:
        organization = (
            create_organization(database) if org_id is None
            else database.get(WorkspaceProfile, org_id)
        )
        create_member(database, organization, "admin", id=actor_id, email=email, username=username)
        database.commit()

    try:
        with Session(guarded_pooled_engine(runtime_url)) as database:
            actor = database.scalar(select(User).where(User.id == actor_id))
            if actor is None:
                raise RuntimeError("The owned administrator could not be loaded")
            database.expunge(actor)
            return actor
    except BaseException:
        delete_owned_admin(owner_url, actor_id)
        raise


def delete_owned_admin(owner_url: str, actor_id: UUID) -> None:
    with guarded_pooled_engine(owner_url).begin() as connection:
        connection.execute(
            text("DELETE FROM public.lifecycle_rate_limit_failures WHERE actor_id = :id"),
            {"id": actor_id},
        )
        connection.execute(
            text("DELETE FROM public.lifecycle_confirmation_challenges WHERE actor_id = :id"),
            {"id": actor_id},
        )
        connection.execute(
            text("DELETE FROM public.lifecycle_rate_limit_buckets WHERE actor_id = :id"),
            {"id": actor_id},
        )
        organizations = connection.execute(
            text("DELETE FROM public.memberships WHERE user_id = :id RETURNING org_id"),
            {"id": actor_id},
        ).scalars().all()
        connection.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": actor_id})
        # A shared organization stays until its last owned administrator is removed.
        for org_id in organizations:
            connection.execute(
                text(
                    "DELETE FROM public.organizations WHERE id = :id AND NOT EXISTS "
                    "(SELECT 1 FROM public.memberships WHERE org_id = :id)"
                ),
                {"id": org_id},
            )
