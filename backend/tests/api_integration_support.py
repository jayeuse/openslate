from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.orm import Session, joinedload
from uuid6 import uuid7

from app.systems.access.users.models import Role, User
from tests.conftest import guarded_create_engine as create_engine


def create_owned_admin(runtime_url: str, owner_url: str, prefix: str) -> User:
    actor_id = uuid7()
    safe_prefix = (
        "".join(character if character.isalnum() else "_" for character in prefix).strip("_")
        or "test_actor"
    )
    email = f"{safe_prefix}-{actor_id}@example.com"
    username = f"{safe_prefix}_{actor_id.hex[:12]}"
    owner_engine = create_engine(owner_url)
    try:
        with owner_engine.begin() as connection:
            role_id = connection.scalar(
                text("SELECT id FROM public.roles WHERE role = 'admin' AND is_deleted = false")
            )
            if role_id is None:
                raise RuntimeError("The local database must contain an active admin role")
            updated = connection.execute(
                text(
                    "INSERT INTO public.users (id, email, username, status, role_id) "
                    "VALUES (:id, :email, :username, 'active', :role_id)"
                ),
                {
                    "id": actor_id,
                    "email": email,
                    "username": username,
                    "role_id": role_id,
                },
            )
            if updated.rowcount != 1:
                raise RuntimeError("The owned administrator could not be created")
    finally:
        owner_engine.dispose()

    try:
        runtime_engine = create_engine(runtime_url)
        try:
            with Session(runtime_engine) as database:
                actor = database.scalar(
                    select(User)
                    .join(Role, User.role_id == Role.id)
                    .options(joinedload(User.role))
                    .where(User.id == actor_id)
                )
                if actor is None:
                    raise RuntimeError("The owned administrator could not be loaded")
                database.expunge(actor)
                return actor
        finally:
            runtime_engine.dispose()
    except BaseException:
        delete_owned_admin(owner_url, actor_id)
        raise


def delete_owned_admin(owner_url: str, actor_id: UUID) -> None:
    owner_engine = create_engine(owner_url)
    try:
        with owner_engine.begin() as connection:
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
    finally:
        owner_engine.dispose()
