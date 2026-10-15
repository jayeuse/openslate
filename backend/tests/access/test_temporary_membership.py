"""S04's temporary authority lookup refuses absent or ambiguous memberships."""

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.systems.access.users.membership import sole_active_membership
from app.systems.access.users.models import Membership
from tests.conftest import create_member, create_organization

pytestmark = pytest.mark.integration


def test_lookup_returns_the_only_active_membership_without_writing(integration_owner_db):
    db = integration_owner_db
    org = create_organization(db)
    user, membership = create_member(db, org, "admin")
    other = create_organization(db)
    create_member(db, other, "guest", user=user, status="pending",
                  sponsor_user_id=user.id, expires_at=membership.created_at)
    before = set(db.scalars(select(Membership.id).where(Membership.user_id == user.id)))
    assert sole_active_membership(db, user.id) is membership
    assert set(db.scalars(select(Membership.id).where(Membership.user_id == user.id))) == before
    assert not db.new and not db.dirty and not db.deleted


@pytest.mark.parametrize("entity", ["account", "membership"])
def test_lookup_does_not_flush_or_discard_pending_changes(integration_owner_db, entity):
    db = integration_owner_db
    user, membership = create_member(db, create_organization(db))
    row, field, changed = ((user, "display_name", "Pending profile change")
                           if entity == "account" else (membership, "role", "admin"))
    previous = getattr(row, field)
    setattr(row, field, changed)
    assert sole_active_membership(db, user.id) is membership
    assert row in db.dirty
    assert getattr(row, field) == changed
    assert db.connection().scalar(
        select(getattr(type(row), field)).where(type(row).id == row.id)
    ) == previous


@pytest.mark.parametrize("state", ["none", "pending", "disabled", "deleted", "multiple"])
def test_lookup_refuses_missing_or_ambiguous_active_membership(integration_owner_db, state):
    db = integration_owner_db
    org = create_organization(db)
    user, membership = create_member(db, org)
    if state == "multiple":
        create_member(db, create_organization(db), "admin", user=user)
    elif state == "none":
        db.connection().execute(
            Membership.__table__.delete().where(Membership.id == membership.id)
        )
    else:
        values = {"is_deleted": True} if state == "deleted" else {"status": state}
        db.connection().execute(
            Membership.__table__.update().where(Membership.id == membership.id).values(**values)
        )
    with pytest.raises(HTTPException) as refusal:
        sole_active_membership(db, user.id)
    assert refusal.value.status_code == 403
