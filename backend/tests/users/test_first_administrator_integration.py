"""The bootstrap reserves the first administrator only on an installation without one.

``operations/bootstrap_admin.py`` counts the administrators before it takes the
administrator lock, so two runs that start together both pass that count. The count
under the lock decides: the second run waits for the first and is then refused. The
reconcile path of a bootstrap re-sends only the sole pending administrator.

A first-administrator bootstrap happens only on an installation without a live
administrator, and the shared test database holds administrators from other tests.
These tests therefore hide every live administrator for their own duration: the race
commits the hiding and restores each row afterwards; the reconcile rows hide them in
their rolled-back transaction.
"""

import os
from collections.abc import Iterator
from datetime import UTC, datetime
from threading import Event, Thread
from typing import Any
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from uuid6 import uuid7

import app.systems.access.users.service as user_service
from app.core.config import get_settings
from app.core.integrations.supabase_auth import ProviderUser
from app.systems.access.users.coordination import InvitationError
from app.systems.access.users.models import User, UserRole, UserStatus
from app.systems.access.users.schemas import InvitationCreate
from operations import bootstrap_admin as bootstrap
from tests.conftest import guarded_create_engine
from tests.race_support import WAIT, backend_pid, wait_until_waiting
from tests.rbac.support import add_user

pytestmark = pytest.mark.integration


def _live_administrators() -> Any:
    return select(User).where(User.role == UserRole.ADMIN.value, User.is_deleted.is_(False))


def _provider() -> Mock:
    """A provider that creates a new identity for each invited email."""

    provider = Mock()
    created: dict[str, UUID] = {}

    def create(email: str, local_id: UUID, operation_id: UUID) -> ProviderUser:
        created[email] = uuid7()
        return ProviderUser(
            created[email],
            None,
            email,
            {
                "openslate_user_id": str(local_id),
                "openslate_invitation_operation_id": str(operation_id),
            },
        )

    provider.find_invitation_user.return_value = None
    provider.admin_create_invitation_user.side_effect = create
    provider.admin_send_invitation.side_effect = lambda email: ProviderUser(
        created[email], None, email
    )
    return provider


@pytest.fixture
def empty_installation(monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[Engine, list[str]]]:
    """Hide every live administrator, then restore each one and remove the invited ones."""

    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    try:
        runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"])
        try:
            monkeypatch.setattr(bootstrap, "get_engine", lambda: runtime)
            invited: list[str] = []
            hidden: dict[UUID, datetime | None] = {}
            try:
                with Session(owner) as db:
                    hidden = {
                        row.id: row.deleted_at for row in db.scalars(_live_administrators()).all()
                    }
                    if hidden:
                        db.execute(
                            update(User)
                            .where(User.id.in_(hidden))
                            .values(is_deleted=True, deleted_at=datetime.now(UTC))
                        )
                    db.commit()
                    assert db.scalars(_live_administrators()).all() == []
                yield owner, invited
            finally:
                with Session(owner) as db:
                    if invited:
                        db.execute(delete(User).where(User.email.in_(invited)))
                    for user_id, deleted_at in hidden.items():
                        db.execute(
                            update(User)
                            .where(User.id == user_id)
                            .values(is_deleted=False, deleted_at=deleted_at)
                        )
                    db.commit()
        finally:
            runtime.dispose()
    finally:
        owner.dispose()


def test_two_bootstraps_that_start_together_reserve_one_administrator(
    empty_installation: tuple[Engine, list[str]], monkeypatch: pytest.MonkeyPatch
) -> None:
    owner, invited = empty_installation
    # Different people: the same email or username would be refused by its unique index.
    first, second = (
        InvitationCreate(
            email=f"{name}-{uuid7().hex}@example.com", username=f"{name}_{uuid7().hex}"
        )
        for name in ("first", "second")
    )
    invited.extend([first.email, second.email])
    monkeypatch.setattr(user_service, "get_supabase_auth_client", _provider)

    first_counted, release_first = Event(), Event()
    second_pid: list[int] = []
    original_exists = user_service._other_administrator_exists
    original_count = bootstrap._admin_assignment_count

    def pause_first_under_the_lock(db: Session, excluded_user_id: UUID) -> bool:
        found = original_exists(db, excluded_user_id)
        if not first_counted.is_set():
            first_counted.set()
            assert release_first.wait(WAIT)
        return found

    def note_second_connection(db: Session, **options: Any) -> int:
        if first_counted.is_set() and not second_pid:
            second_pid.append(backend_pid(db))
        return original_count(db, **options)

    monkeypatch.setattr(user_service, "_other_administrator_exists", pause_first_under_the_lock)
    monkeypatch.setattr(bootstrap, "_admin_assignment_count", note_second_connection)
    results: dict[str, object] = {}

    def run(invitation: InvitationCreate) -> None:
        try:
            results[invitation.email] = bootstrap._provision(get_settings(), invitation)
        except bootstrap.BootstrapError as error:
            results[invitation.email] = error

    runs = [Thread(target=run, args=(first,)), Thread(target=run, args=(second,))]
    try:
        runs[0].start()
        assert first_counted.wait(WAIT)
        runs[1].start()
        # Only a synchronization: the second run either waits for the first's lock or,
        # without that lock, finishes on its own before the first is released.
        wait_until_waiting(owner, second_pid, while_running=runs[1])
    finally:
        release_first.set()
        for thread in runs:
            thread.join(WAIT)
    assert not any(thread.is_alive() for thread in runs), "a bootstrap hung"

    assert isinstance(results[first.email], bootstrap.BootstrapResult), results
    assert isinstance(results[second.email], bootstrap.BootstrapError), results
    with Session(owner) as db:
        reserved = db.scalars(
            select(User.email).where(
                User.email.in_(invited),
                User.role == UserRole.ADMIN.value,
                User.is_deleted.is_(False),
            )
        ).all()
        assert reserved == [first.email]
        assert db.scalar(select(func.count()).select_from(_live_administrators().subquery())) == 1


@pytest.mark.parametrize(
    ("other_administrator", "reconciled"),
    [
        pytest.param(False, True, id="sole-pending-administrator"),
        pytest.param(True, False, id="another-live-administrator"),
    ],
)
def test_a_bootstrap_reconcile_resends_only_the_sole_pending_administrator(
    integration_owner_db: Session, other_administrator: bool, reconciled: bool
) -> None:
    db = integration_owner_db
    for administrator in db.scalars(_live_administrators()).all():
        administrator.is_deleted = True
        administrator.deleted_at = datetime.now(UTC)
    # Neither a deleted administrator nor a member stops the first administrator.
    deleted = add_user(db, "deleted-admin", role=UserRole.ADMIN)
    deleted.is_deleted = True
    deleted.deleted_at = datetime.now(UTC)
    add_user(db, "member")
    if other_administrator:
        add_user(db, "other-admin", role=UserRole.ADMIN)
    pending = add_user(db, "pending-admin", role=UserRole.ADMIN, status=UserStatus.PENDING)
    pending.provider_invitation_operation_id = uuid7()
    db.commit()

    if reconciled:
        result = user_service.reconcile_invitation(
            db, pending.id, actor_id=None, bootstrap=True, client=_provider()
        )
        assert result.supabase_user_id is not None
        assert result.invitation_sent_at is not None
    else:
        with pytest.raises(InvitationError):
            user_service.reconcile_invitation(
                db, pending.id, actor_id=None, bootstrap=True, client=_provider()
            )
        stored = db.get(User, pending.id)
        assert stored is not None
        assert (stored.supabase_user_id, stored.invitation_sent_at) == (None, None)
