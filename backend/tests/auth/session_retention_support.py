"""Owned users, sessions and retention proofs for the terminal-session cleanup tests."""

from types import SimpleNamespace
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database.session import get_engine
from app.systems.access.identity.models import IdentitySession
from app.systems.access.users.models import Membership, User
from app.systems.manage.audit.models import SecurityEvent
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member, create_organization


@pytest.fixture
def world(integration_owner_db):
    owner = integration_owner_db.get_bind().engine
    runtime = get_engine()
    users = []
    events = []
    with Session(owner) as db:
        before = set(db.scalars(select(SecurityEvent.id)))
        organization_id = create_organization(db).id
        db.commit()

    def add_users(count=1):
        with Session(owner) as db:
            organization = db.get(WorkspaceProfile, organization_id)
            rows = [
                create_member(db, organization, id=uuid4(), username=str(uuid4()),
                              email=f"{uuid4()}@example.test", status="active")[0]
                for _ in range(count)
            ]
            users.extend(row.id for row in rows)
            db.commit()
        return users[-count:]

    def add_sessions(fields):
        rows = [
            IdentitySession(
                id=uuid4(),
                user_id=item.pop("user_id", users[0]),
                refresh_token_digest=str(uuid4()),
                csrf_token_digest="owned",
                **item,
            )
            for item in fields
        ]
        ids = [row.id for row in rows]
        with Session(owner) as db:
            db.add_all(rows)
            db.commit()
        return ids

    def proofs():
        # In commit order: without ORDER BY, PostgreSQL may return the rows in any order
        # (seen on a second run on the same stack, after earlier proofs were deleted).
        with Session(owner) as db:
            return list(
                db.scalars(
                    select(SecurityEvent)
                    .where(
                        SecurityEvent.source == "identity.session_retention",
                        SecurityEvent.id.not_in(before),
                    )
                    .order_by(SecurityEvent.occurred_at, SecurityEvent.id)
                )
            )

    def cleanup():
        with Session(owner) as db:
            for row in db.scalars(
                select(SecurityEvent).where(
                    (SecurityEvent.source == "identity.session_retention")
                    & SecurityEvent.id.not_in(before)
                    | SecurityEvent.id.in_(events)
                )
            ):
                db.delete(row)
            for row in db.scalars(select(Membership).where(Membership.user_id.in_(users))):
                db.delete(row)
            db.flush()
            for row in db.scalars(select(User).where(User.id.in_(users))):
                db.delete(row)
            db.flush()
            db.delete(db.get(WorkspaceProfile, organization_id))
            db.commit()

    try:
        add_users()
        yield SimpleNamespace(
            owner=owner,
            runtime=runtime,
            users=users,
            events=events,
            add_users=add_users,
            add_sessions=add_sessions,
            proofs=proofs,
        )
    finally:
        cleanup()
