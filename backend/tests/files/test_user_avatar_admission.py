"""Creator-owned image admission through real identity and PostgreSQL."""

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.platform.files.models import File
from app.systems.platform.files.quota import lock_quota, require_capacity
from tests.files.user_avatar_support import (
    actor_role,
    image,
    native_avatar,
    ready_avatar,
    reserved_avatar,
    stored_file,
)
from tests.files.user_avatar_support import (
    avatar_world as avatar_world,
)
from tests.files.user_avatar_support import (
    policy_world as policy_world,
)

pytestmark = pytest.mark.integration


@pytest.mark.parametrize(
    "role,format,mime", [("member", "PNG", "image/png"), ("guest", "JPEG", "image/jpeg")]
)
def test_member_and_guest_upload_owned_normalized_avatar_without_shared_access(
    avatar_world, role, format, mime
):
    world = avatar_world
    actor_role(world, role)
    file_id, key = ready_avatar(world, format=format)
    file = stored_file(world, file_id)
    assert file.creator_id == world.actor_id and file.purpose == "user_avatar"
    assert file.state == "ready" and file.media_type == mime
    assert file.actual_size == len(world.storage.objects[key]) <= 2 * 1024 * 1024
    assert file.digest and file.operation_id is None
    own = world.client.get(f"/api/files/{file_id}", headers=world.headers())
    assert own.status_code == 200 and own.json()["creator_id"] == str(world.actor_id)


@pytest.mark.parametrize(
    "values",
    [
        {"expected_size": 2097153},
        {"expected_size": 0},
        {"record_id": "not-an-id"},
        {"filename": "avatar.svg"},
    ],
)
def test_avatar_reservation_refuses_invalid_bounds_parents_and_non_image_name(avatar_world, values):
    world = avatar_world
    response = world.client.post(
        "/api/files",
        headers=world.headers(),
        json={
            "purpose": "user_avatar",
            "filename": "avatar.png",
            "expected_size": 10,
            **values,
        },
    )
    assert response.status_code == 422, response.text
    with Session(world.owner) as db:
        assert list(db.scalars(select(File.id).where(File.creator_id == world.actor_id))) == []
    assert not world.storage.uploaded


@pytest.mark.parametrize(
    "content,filename", [(b"not a png", "avatar.png"), (image("JPEG"), "avatar.png")]
)
def test_invalid_or_disguised_avatar_never_reaches_private_storage(avatar_world, content, filename):
    world = avatar_world
    file_id, _ = reserved_avatar(world, content, filename)
    response = world.client.put(
        f"/api/files/{file_id}/content",
        headers={**world.headers(), "Content-Type": "application/octet-stream"},
        content=content,
    )
    assert response.status_code == 422
    assert not world.storage.uploaded and stored_file(world, file_id).state == "awaiting_upload"


def test_avatar_inventory_and_generic_actions_are_creator_only_even_for_admin(avatar_world):
    world = avatar_world
    own, _ = native_avatar(world)
    other, _ = native_avatar(world, owner_id=world.target_id)
    listing = world.client.get("/api/files?purpose=user_avatar", headers=world.headers())
    assert listing.status_code == 200, listing.text
    assert [row["id"] for row in listing.json()["items"]] == [str(own)]
    for method, path in (
        ("GET", f"/api/files/{other}"),
        ("GET", f"/api/files/{other}/content"),
        ("POST", f"/api/files/{other}/archive"),
        ("PUT", f"/api/files/{other}/content"),
    ):
        response = world.client.request(
            method,
            path,
            headers={**world.headers(), "Content-Type": "application/octet-stream"},
            content=image(),
        )
        assert response.status_code == 404, response.text
    assert world.storage.deleted == [] and stored_file(world, other).state == "ready"


def test_avatar_pending_quota_charges_canonical_image_budget(avatar_world):
    from uuid import uuid4

    from fastapi import HTTPException

    world = avatar_world
    with Session(world.owner) as db:
        from app.systems.access.users.models import Membership

        org_id = db.scalars(
            select(Membership.org_id).where(Membership.user_id == world.actor_id)
        ).one()
        # Pending organization files never consume an account's avatar budget.
        db.add(
            File(
                org_id=org_id,
                purpose="workspace_logo",
                creator_id=world.actor_id,
                filename="logo.png",
                expected_size=1,
                object_key=f"org/{org_id}/{uuid4().hex}",
                state="awaiting_upload",
            )
        )
        # Two pending avatars of this account consume two canonical budgets, not two bytes.
        for name in ("first.png", "last.png"):
            db.add(File(
                org_id=None,
                purpose="user_avatar",
                creator_id=world.actor_id,
                filename=name,
                expected_size=1,
                object_key=f"user/{world.actor_id}/{uuid4().hex}",
                state="awaiting_upload",
            ))
        db.commit()
        lock_quota(db)
        require_capacity(db, "user_avatar", 1, creator_id=world.actor_id)
        # A reduced capacity boundary exposes the avatar charge without crossing the
        # separate 100-reservation count cap. The SQL occupancy and charge are real.
        from unittest.mock import patch

        with patch("app.systems.platform.files.quota.PENDING_UPLOAD_BYTES", 4 * 1024 * 1024):
            with pytest.raises(HTTPException) as refused:
                require_capacity(db, "user_avatar", 1, creator_id=world.actor_id)
        assert refused.value.detail["code"] == "file_uploads_full"
