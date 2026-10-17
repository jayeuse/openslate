"""One pending invitation is reserved atomically across independently admitted admins."""

import os
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import Mock
from uuid import UUID

import pytest
from sqlalchemy import delete, select
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from uuid6 import uuid7

from app.core.database.organization_scope import scope_session
from app.core.database.session import AuditSession
from app.systems.access.identity.mfa_observations import initialize_observation
from app.systems.access.identity.models import IdentityMfaObservation
from app.systems.access.users import service
from app.systems.access.users.coordination import InvitationConflict
from app.systems.access.users.models import Membership, User
from app.systems.access.users.schemas import InvitationCreate
from app.systems.manage.audit.models import AuditLog, SecurityEvent
from app.systems.manage.workspace.models import WorkspaceProfile
from tests.conftest import create_member, create_organization, guarded_create_engine
from tests.race_support import WAIT

pytestmark = pytest.mark.integration


@pytest.fixture
def invitation_world() -> Iterator[tuple[Engine, Engine, dict[str, UUID]]]:
    owner = guarded_create_engine(os.environ["MIGRATION_DATABASE_URL"])
    runtime = guarded_create_engine(os.environ["TEST_DATABASE_URL"], pool_size=4)
    with Session(owner) as db:
        a, b, c = create_organization(db), create_organization(db), create_organization(db)
        admin_a, _ = create_member(db, a, role="admin")
        admin_b, _ = create_member(db, b, role="admin")
        target, _ = create_member(db, c, supabase_user_id=uuid7())
        initialize_observation(db, target.id)
        data = dict(a=a.id, b=b.id, c=c.id, admin_a=admin_a.id,
                    admin_b=admin_b.id, target=target.id)
        db.commit()
    try:
        yield owner, runtime, data
    finally:
        with Session(owner) as db:
            people = (data["admin_a"], data["admin_b"], data["target"])
            db.execute(delete(SecurityEvent).where(
                SecurityEvent.actor_id.in_(people) | SecurityEvent.subject_id.in_(people)))
            db.execute(delete(AuditLog).where(
                AuditLog.org_id.in_((data["a"], data["b"], data["c"]))))
            db.execute(delete(IdentityMfaObservation).where(IdentityMfaObservation.user_id.in_(people)))
            db.execute(delete(Membership).where(Membership.user_id.in_(people)))
            db.execute(delete(User).where(User.id.in_(people)))
            db.execute(delete(WorkspaceProfile).where(WorkspaceProfile.id.in_(
                (data["a"], data["b"], data["c"]))))
            db.commit()
        runtime.dispose()
        owner.dispose()


def test_concurrent_a_b_invitations_reserve_one_pending_membership(
    invitation_world: tuple[Engine, Engine, dict[str, UUID]], monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner, runtime, data = invitation_world
    prechecks_done = Barrier(2)
    provider = Mock()

    def after_prechecks(db: Session, user_id: UUID) -> None:
        # Both independent admins have passed the pending lookup before either insert flushes.
        prechecks_done.wait(timeout=WAIT)
        initialize_observation(db, user_id)

    monkeypatch.setattr(service, "initialize_observation", after_prechecks)
    with Session(owner) as db:
        target = db.get(User, data["target"])
        payload = InvitationCreate(email=target.email, username=target.username, role="member")

    def invite(organization: str) -> str:
        with AuditSession(runtime) as db:
            scope_session(db, data[organization])
            try:
                result = service.invite_user(db, payload, actor_id=data[f"admin_{organization}"],
                                             client=provider)
                assert result.id == data["target"]
                return "invited"
            except InvitationConflict as error:
                return str(error)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(invite, organization) for organization in ("a", "b")]
        outcomes = [future.result(timeout=WAIT * 2) for future in futures]
    assert sorted(outcomes) == ["This person cannot be invited right now", "invited"]
    provider.admin_create_invitation_user.assert_not_called()
    provider.admin_send_invitation.assert_not_called()
    with Session(owner) as db:
        rows = db.scalars(select(Membership).where(Membership.user_id == data["target"])).all()
        assert len(rows) == 2
        pending = [row for row in rows if row.status == "pending" and not row.is_deleted]
        assert len(pending) == 1 and pending[0].org_id in (data["a"], data["b"])
        assert next(row for row in rows if row.org_id == data["c"]).status == "active"


def test_pending_membership_unique_slot_excludes_accepted_and_deleted_rows(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    a, b, c = create_organization(db), create_organization(db), create_organization(db)
    user, _ = create_member(db, a)
    deleted = Membership(org_id=b.id, user_id=user.id, role="member",
                         status="pending", is_deleted=True)
    live = Membership(org_id=c.id, user_id=user.id, role="member", status="pending")
    db.add_all([deleted, live])
    db.flush()
    savepoint = db.begin_nested()
    deleted.is_deleted = False
    with pytest.raises(IntegrityError) as conflict:
        db.flush()
    savepoint.rollback()
    assert conflict.value.orig.diag.constraint_name == "uq_memberships_user_pending"
    db.refresh(deleted)
    assert deleted.is_deleted
    live.status = "active"
    db.flush()
    deleted.is_deleted = False
    db.flush()
    assert deleted.status == "pending" and live.status == "active"
