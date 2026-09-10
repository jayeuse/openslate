"""Guarded fixtures confined to the parent-owned disposable file test stack."""

from uuid import uuid4

import pytest
from sqlalchemy import select, text

from app.systems.users.models import Role, User


@pytest.fixture
def guarded_db(request):
    # Central guard validates the isolated owner target before any fixture connection.
    return request.getfixturevalue("integration_owner_db")


@pytest.fixture
def actor(guarded_db):
    db = guarded_db
    identity = uuid4()
    db.connection().execute(
        text("INSERT INTO auth.users (id,email) VALUES (:id,:email)"),
        {"id": identity, "email": f"file-{identity}@example.com"},
    )
    user = db.get(User, identity)
    user.role_id = db.scalar(select(Role.id).where(Role.role == "admin"))
    user.status = "active"
    user.invitation_sent_at = None
    db.commit()
    return user


@pytest.fixture
def file_request():
    from fastapi import Request

    from app.systems.files.providers import transfer_slot

    with transfer_slot() as lease:
        request = Request({"type": "http", "state": {"file_transfer_lease": lease}})
        yield request
