from uuid import UUID

from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session, joinedload
from uuid6 import uuid7

from app.systems.users.models import Role, User


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
            connection.execute(
                text("INSERT INTO auth.users (id, email) VALUES (:id, :email)"),
                {"id": actor_id, "email": email},
            )
            updated = connection.execute(
                text(
                    "UPDATE public.users SET email = :email, username = :username, "
                    "status = 'active', role_id = :role_id, is_deleted = false, "
                    "deleted_at = NULL, invitation_sent_at = NULL, "
                    "invitation_accepted_at = NULL WHERE id = :id"
                ),
                {
                    "id": actor_id,
                    "email": email,
                    "username": username,
                    "role_id": role_id,
                },
            )
            if updated.rowcount != 1:
                raise RuntimeError("The Auth profile trigger did not create the owned profile")
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
            connection.execute(text("DELETE FROM auth.users WHERE id = :id"), {"id": actor_id})
    finally:
        owner_engine.dispose()
