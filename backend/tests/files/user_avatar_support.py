"""Owned committed avatar inventory and storage boundary for admission/delivery/races."""

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from hashlib import sha256
from io import BytesIO
from uuid import UUID, uuid4

import pytest
from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.users.models import Membership, User
from app.systems.platform.files.models import File
from app.systems.platform.files.storage import get_storage
from tests.auth.session_policy_support import policy_world as policy_world


@dataclass
class Store:
    objects: dict[str, bytes] = field(default_factory=dict)
    uploaded: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    read_effect: Callable[[], None] | None = None
    delete_effect: Callable[[], None] | None = None

    def upload(self, key, content, media_type):
        assert key not in self.objects
        self.objects[key] = content
        self.uploaded.append(key)

    def download(self, key):
        content = self.objects.get(key)
        if self.read_effect is not None:
            self.read_effect()
        return content

    def delete(self, key):
        if self.delete_effect is not None:
            self.delete_effect()
        self.deleted.append(key)
        self.objects.pop(key, None)


def image(format="PNG"):
    output = BytesIO()
    Image.new("RGB", (3, 2), (50, 100, 150)).save(output, format=format)
    return output.getvalue()


@pytest.fixture
def avatar_world(policy_world):
    world = policy_world
    world.storage = Store()
    world.client.app.dependency_overrides[get_storage] = lambda: world.storage
    try:
        yield world
    finally:
        world.client.app.dependency_overrides.pop(get_storage, None)
        with Session(world.owner) as db:
            for identity in (world.actor_id, world.target_id):
                user = db.get(User, identity)
                if user is not None:
                    user.avatar_file_id = None
            db.flush()
            for file in db.scalars(
                select(File).where(File.creator_id.in_([world.actor_id, world.target_id]))
            ):
                db.delete(file)
            db.commit()


def actor_role(world, role):
    with Session(world.owner) as db:
        actor = db.scalars(select(Membership).where(Membership.user_id == world.actor_id)).one()
        actor.role = role
        actor.sponsor_user_id = world.target_id if role == "guest" else None
        actor.expires_at = world.clock + timedelta(days=1) if role == "guest" else None
        db.commit()


def reserved_avatar(world, content=None, filename="avatar.png"):
    content = image() if content is None else content
    reserved = world.client.post(
        "/api/files",
        headers=world.headers(),
        json={
            "purpose": "user_avatar",
            "filename": filename,
            "expected_size": len(content),
        },
    )
    assert reserved.status_code == 201, reserved.text
    return UUID(reserved.json()["id"]), content


def ready_avatar(world, *, bind=False, format="PNG"):
    file_id, content = reserved_avatar(
        world, image(format), "avatar.png" if format == "PNG" else "avatar.jpg"
    )
    uploaded = world.client.put(
        f"/api/files/{file_id}/content",
        headers={**world.headers(), "Content-Type": "application/octet-stream"},
        content=content,
    )
    assert uploaded.status_code == 200, uploaded.text
    if bind:
        assert profile_patch(world, avatar_file_id=str(file_id)).status_code == 200
    return file_id, stored_file(world, file_id).object_key


def native_avatar(world, *, owner_id=None, bind=False, purpose="user_avatar", org_id=None):
    """Owned valid committed inventory, for a second account without fabricating auth."""
    owner_id = owner_id or world.actor_id
    content = image()
    with Session(world.owner) as db:
        file = File(
            purpose=purpose,
            org_id=org_id,
            creator_id=owner_id,
            filename="avatar.png",
            expected_size=len(content),
            actual_size=len(content),
            media_type="image/png",
            digest=sha256(content).hexdigest(),
            object_key=uuid4().hex,
            state="ready",
        )
        db.add(file)
        db.flush()
        if bind:
            db.get(User, owner_id).avatar_file_id = file.id
        db.commit()
        world.storage.objects[file.object_key] = content
        return file.id, file.object_key


def stored_file(world, file_id):
    with Session(world.owner) as db:
        return db.get(File, file_id)


def binding(world):
    with Session(world.owner) as db:
        actor = db.get(User, world.actor_id)
        return actor.avatar_file_id, actor.phone, actor.bio


def profile_patch(world, **values):
    return world.client.patch("/api/auth/me/profile", headers=world.headers(), json=values)
