"""Give a route-test client a live application session for the actor.

Writers that recheck access after long work (``get_current_identity`` plus
``require_live_session``) need the exact ``IdentitySession`` row to exist,
belong to the actor and be unexpired. Tests that only override
``get_current_user`` reach the real identity dependency and get 401.
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.common.dependencies.auth import CurrentIdentity, get_current_identity, get_current_user
from app.core.base_model import utc_now
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import User
from app.systems.manage.audit.context import set_audit_actor


def with_live_session(client: TestClient, db: Session, actor: User) -> TestClient:
    """Commit a live session for *actor* and resolve both auth dependencies to it.

    The commit keeps the session row when a refused route rolls back to the
    last savepoint; the fixture's outer transaction still discards it.
    """

    now = utc_now()
    session = IdentitySession(
        user_id=actor.id,
        refresh_token_digest=uuid7().hex + uuid7().hex,
        csrf_token_digest=uuid7().hex + uuid7().hex,
        created_at=now,
        refreshed_at=now,
        expires_at=now + timedelta(hours=1),
    )
    db.add(session)
    db.commit()
    session_id = session.id

    def identity() -> CurrentIdentity:
        set_audit_actor(db, actor.id)
        return CurrentIdentity(actor, session_id, False, False)

    app = client.app
    assert isinstance(app, FastAPI)
    app.dependency_overrides[get_current_user] = lambda: actor
    app.dependency_overrides[get_current_identity] = identity
    return client
