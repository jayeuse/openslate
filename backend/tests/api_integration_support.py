from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.systems.access.users.models import User
from tests.conftest import guarded_pooled_engine


def create_owned_admin(runtime_url: str, owner_url: str, prefix: str) -> User:
    actor_id = uuid7()
    safe_prefix = (
        "".join(character if character.isalnum() else "_" for character in prefix).strip("_")
        or "test_actor"
    )
    email = f"{safe_prefix}-{actor_id}@example.com"
    username = f"{safe_prefix}_{actor_id.hex[:12]}"
    with guarded_pooled_engine(owner_url).begin() as connection:
        updated = connection.execute(
            text(
                "INSERT INTO public.users (id, email, username, status, role) "
                "VALUES (:id, :email, :username, 'active', 'admin')"
            ),
            {"id": actor_id, "email": email, "username": username},
        )
        if updated.rowcount != 1:
            raise RuntimeError("The owned administrator could not be created")

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
        connection.execute(text("DELETE FROM public.users WHERE id = :id"), {"id": actor_id})
