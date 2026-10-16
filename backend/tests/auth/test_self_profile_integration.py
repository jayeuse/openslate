"""Self-only profile writes through signed identity, PostgreSQL and audit."""

from datetime import timedelta
from unittest.mock import patch

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog
from tests.auth.session_policy_support import policy_world as policy_world
from tests.conftest import membership_of

pytestmark = pytest.mark.integration
PATH = "/api/auth/me/profile"
TEXT = {
    "display_name": "Profile owner",
    "job_title": "Editor",
    "phone": "+1 local",
    "bio": "About me",
}


def audits(world):
    with Session(world.owner) as db:
        return list(
            db.scalars(
                select(AuditLog).where(
                    AuditLog.entity_type == "users",
                    AuditLog.entity_id == world.actor_id,
                    AuditLog.action == "update",
                    AuditLog.request_path == PATH,
                )
            )
        )


def role(world, value):
    with Session(world.owner) as db:
        user = membership_of(db, world.actor_id)
        user.role = value
        user.sponsor_user_id = world.target_id if value == "guest" else None
        user.expires_at = world.clock + timedelta(days=1) if value == "guest" else None
        db.commit()


@pytest.mark.parametrize("viewer", ["member", "guest"])
def test_self_profile_persists_actual_private_values_without_shared_access(policy_world, viewer):
    world = policy_world
    role(world, viewer)
    saved = world.client.patch(PATH, headers=world.headers(), json=TEXT)
    assert saved.status_code == 200, saved.text
    assert "no-store" in saved.headers["cache-control"]
    body = saved.json()
    assert {key: body[key] for key in TEXT} == TEXT
    assert body["avatar_file_id"] is None and body["access"] == []
    read = world.client.get("/api/auth/me", headers=world.headers())
    assert read.status_code == 200
    assert {key: read.json()[key] for key in (*TEXT, "avatar_file_id")} == {
        **TEXT,
        "avatar_file_id": None,
    }
    with Session(world.owner) as db:
        user = db.get(User, world.actor_id)
        target = db.get(User, world.target_id)
        assert {key: getattr(user, key) for key in TEXT} == TEXT
        assert target.display_name is None and target.phone is None and target.bio is None
    rows = audits(world)
    assert len(rows) == 1 and rows[0].performed_by == world.actor_id
    assert set(rows[0].after) == set(TEXT)


def test_self_partial_clear_and_noop_preserve_omissions_and_do_not_audit_reads(policy_world):
    world = policy_world
    assert world.client.patch(PATH, headers=world.headers(), json=TEXT).status_code == 200
    before = world.client.get("/api/auth/me", headers=world.headers()).json()
    for values in ({}, TEXT):
        saved = world.client.patch(PATH, headers=world.headers(), json=values)
        assert saved.status_code == 200
        assert saved.json()["updated_at"] == before["updated_at"]
    assert len(audits(world)) == 1
    cleared = world.client.patch(PATH, headers=world.headers(), json={"phone": None, "bio": None})
    assert cleared.status_code == 200
    assert {key: cleared.json()[key] for key in TEXT} == {**TEXT, "phone": None, "bio": None}
    assert len(audits(world)) == 2


@pytest.mark.parametrize(
    "values",
    [
        {"user_id": "actor"},
        {"role": "admin"},
        {"email": "changed@example.test"},
        {"username": "changed"},
        {"access": []},
        {"sponsor_user_id": None},
        {"phone": "x" * 33},
        {"bio": "x" * 281},
        {"display_name": "x" * 201},
    ],
)
def test_self_profile_rejects_unapproved_fields_and_bounds_without_writes(policy_world, values):
    world = policy_world
    before = world.client.get("/api/auth/me", headers=world.headers()).json()
    refused = world.client.patch(PATH, headers=world.headers(), json=values)
    assert refused.status_code == 422, refused.text
    assert world.client.get("/api/auth/me", headers=world.headers()).json() == before
    assert audits(world) == []


def test_self_profile_requires_current_identity_and_browser_csrf(policy_world):
    world = policy_world
    assert world.client.patch(PATH, json=TEXT).status_code == 401
    world.client.cookies.set("openslate_access", world.access())
    world.client.cookies.set("openslate_refresh", world.handles[0])
    assert world.client.patch(PATH, json=TEXT).status_code == 401
    world.client.cookies.clear()
    with Session(world.owner) as db:
        db.get(IdentitySession, world.session_ids[0]).revoked_at = world.clock
        db.commit()
    assert world.client.patch(PATH, headers=world.headers(), json=TEXT).status_code == 401
    assert audits(world) == []


def test_self_profile_current_locked_merge_keeps_an_independent_disjoint_edit(policy_world):
    world = policy_world
    changed = []

    def after_auth(_db, instance):
        if isinstance(instance, User) and instance.id == world.actor_id and not changed:
            changed.append(True)
            with Session(world.owner) as concurrent:
                concurrent.get(User, world.actor_id).bio = "Concurrent bio"
                concurrent.commit()

    event.listen(AuditSession, "loaded_as_persistent", after_auth)
    try:
        saved = world.client.patch(PATH, headers=world.headers(), json={"phone": "New phone"})
        assert saved.status_code == 200, saved.text
        assert saved.json()["phone"] == "New phone" and saved.json()["bio"] == "Concurrent bio"
    finally:
        event.remove(AuditSession, "loaded_as_persistent", after_auth)
    assert changed and len(audits(world)) == 1


def test_self_profile_commit_failure_rolls_back_values_and_audit(policy_world):
    world = policy_world

    def fail_commit(db):
        db.flush()
        raise SQLAlchemyError("private-canary")

    with patch.object(AuditSession, "commit", fail_commit):
        refused = world.client.patch(PATH, headers=world.headers(), json=TEXT)
    assert refused.status_code == 503 and "private-canary" not in refused.text
    read = world.client.get("/api/auth/me", headers=world.headers()).json()
    assert all(read[key] is None for key in (*TEXT, "avatar_file_id"))
    assert audits(world) == []


def test_directory_and_other_user_dto_do_not_gain_private_profile_fields(policy_world):
    world = policy_world
    assert world.client.patch(PATH, headers=world.headers(), json=TEXT).status_code == 200
    private = {"phone", "bio", "avatar_file_id"}
    row = world.client.get(f"/api/users/{world.actor_id}", headers=world.headers())
    assert row.status_code == 200 and private.isdisjoint(row.json())
    directory = world.client.get("/api/users", headers=world.headers())
    assert directory.status_code == 200
    assert all(private.isdisjoint(row) for row in directory.json()["items"])
