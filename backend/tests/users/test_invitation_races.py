"""An invitation binds its provider identity only to a profile that is still pending.

The invitation commits the pending profile, then asks the provider to create and email
the identity. A delete that commits while the email is in flight must win: the binding
waits for it and then refuses, instead of writing the binding over the deleted profile.
"""

import os
from collections.abc import Iterator
from datetime import UTC, datetime
from threading import Event, Thread
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy import delete, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.service as user_service
from app.core.integrations.supabase_auth import ProviderUser
from app.systems.access.users.coordination import InvitationError, lock_user
from app.systems.access.users.models import User, UserRole
from app.systems.access.users.schemas import InvitationCreate
from tests.access.access_race_support import add_race_user
from tests.conftest import guarded_create_engine
from tests.race_support import WAIT, backend_pid, wait_until_blocked_by

pytestmark = pytest.mark.integration


@pytest.fixture
def engines() -> Iterator[tuple[Engine, Engine, UUID, str]]:
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=3)
    with Session(owner) as db:
        admin = add_race_user(db, "race", UserRole.ADMIN.value)
        db.commit()
    email = f"invited-{uuid7().hex}@example.com"
    try:
        yield owner, runtime, admin, email
    finally:
        with Session(owner) as db:
            db.execute(delete(User).where(User.email == email))
            db.execute(delete(User).where(User.id == admin))
            db.commit()
        runtime.dispose()
        owner.dispose()


def test_a_delete_that_commits_while_the_invitation_email_is_sent_is_kept(
    engines: tuple[Engine, Engine, UUID, str],
) -> None:
    owner, runtime, admin, email = engines
    provider_id = uuid7()
    sending, release_send = Event(), Event()
    provider = Mock()
    provider.admin_create_invitation_user.side_effect = lambda address, local_id, operation: (
        ProviderUser(
            provider_id,
            None,
            address,
            {
                "openslate_user_id": str(local_id),
                "openslate_invitation_operation_id": str(operation),
            },
        )
    )

    def send(address: str) -> ProviderUser:
        # The pending profile is committed; the email is in flight.
        sending.set()
        assert release_send.wait(WAIT)
        return ProviderUser(provider_id, None, address)

    provider.admin_send_invitation.side_effect = send
    payload = InvitationCreate(email=email, username=f"invited_{uuid7().hex[:20]}")
    outcome: list[object] = []

    def invite() -> None:
        with Session(runtime) as db:
            try:
                outcome.append(
                    user_service.invite_user(db, payload, actor_id=admin, client=provider)
                )
            except InvitationError as error:
                outcome.append(error)

    inviter = Thread(target=invite)
    inviter.start()
    try:
        assert sending.wait(WAIT)
        with Session(owner) as deleting:
            invited_id = deleting.scalar(select(User.id).where(User.email == email))
            assert invited_id is not None
            # The lock and the change of an administrator's delete of the pending profile.
            profile = lock_user(deleting, invited_id)
            profile.is_deleted = True
            profile.deleted_at = datetime.now(UTC)
            deleting.flush()
            release_send.set()
            wait_until_blocked_by(owner, backend_pid(deleting))
            deleting.commit()
    finally:
        release_send.set()
        inviter.join(WAIT)
    assert not inviter.is_alive(), "the invitation hung"

    assert len(outcome) == 1 and isinstance(outcome[0], InvitationError), outcome
    with Session(owner) as db:
        stored = db.scalar(select(User).where(User.email == email))
        assert stored is not None
        assert stored.is_deleted is True
        assert (stored.supabase_user_id, stored.invitation_sent_at) == (None, None)
