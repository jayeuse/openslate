"""The access function on PostgreSQL: its reads, the account check (rule 2) and denials.

The stack-free table in ``test_access_fold.py`` owns the fold (rules 1 and 3 to 6). These
cases keep what needs the database: the live rows of live groups and memberships, the
modules each row reaches (including modules created after the row), the administrator
and inactive-account checks before any read, and the authorization denials.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.base_model import utc_now
from app.systems.access.policy.models import AccessLevel, Group, GroupMember
from app.systems.access.policy.scope import allowed_module_ids, effective_levels, level_for
from app.systems.access.users.models import Membership, UserRole, UserStatus
from tests.conftest import create_member, create_organization, membership_of
from tests.rbac.support import add_department, add_module, add_user, make_group_access

pytestmark = pytest.mark.integration

READ, WRITE, MANAGE = AccessLevel.READ, AccessLevel.WRITE, AccessLevel.MANAGE


def test_administrator_manages_everything_without_a_group(integration_db: Session) -> None:
    admin = add_user(integration_db, role=UserRole.ADMIN)
    finance = add_department(integration_db)
    ledger = add_module(integration_db, finance)

    assert level_for(integration_db, admin, finance.id, ledger.id) is MANAGE
    assert level_for(integration_db, admin, finance.id) is MANAGE
    assert allowed_module_ids(integration_db, admin, MANAGE) is None


def test_member_without_a_group_for_the_department_gets_nothing(integration_db: Session) -> None:
    member = add_user(integration_db)
    finance = add_department(integration_db)
    ledger = add_module(integration_db, finance)
    other = add_department(integration_db)
    make_group_access(integration_db, [member], other, level=MANAGE)

    assert level_for(integration_db, member, finance.id, ledger.id) is None
    assert level_for(integration_db, member, finance.id) is None
    assert ledger.id not in (allowed_module_ids(integration_db, member, READ) or ())


def test_department_row_covers_every_module_including_later_ones(integration_db: Session) -> None:
    member = add_user(integration_db)
    inventory = add_department(integration_db)
    products = add_module(integration_db, inventory)
    make_group_access(integration_db, [member], inventory, level=READ)
    prices = add_module(integration_db, inventory)
    finance = add_department(integration_db)
    ledger = add_module(integration_db, finance)

    readable = allowed_module_ids(integration_db, member, READ)

    assert readable == frozenset({products.id, prices.id})
    assert ledger.id not in readable
    assert level_for(integration_db, member, inventory.id) is READ
    assert allowed_module_ids(integration_db, member, WRITE) == frozenset()


def test_most_specific_row_of_one_group_wins_even_when_lower(integration_db: Session) -> None:
    member = add_user(integration_db)
    inventory = add_department(integration_db)
    products = add_module(integration_db, inventory)
    prices = add_module(integration_db, inventory)
    department_row = make_group_access(integration_db, [member], inventory, level=WRITE)
    group = integration_db.get(Group, department_row.group_id)
    make_group_access(integration_db, [], inventory, prices, level=READ, group=group)

    assert level_for(integration_db, member, inventory.id, prices.id) is READ
    assert level_for(integration_db, member, inventory.id, products.id) is WRITE
    assert allowed_module_ids(integration_db, member, WRITE) == frozenset({products.id})


def test_module_only_access_does_not_open_the_department(integration_db: Session) -> None:
    member = add_user(integration_db)
    inventory = add_department(integration_db)
    products = add_module(integration_db, inventory)
    prices = add_module(integration_db, inventory)
    make_group_access(integration_db, [member], inventory, prices, level=WRITE)

    assert level_for(integration_db, member, inventory.id) is None
    assert level_for(integration_db, member, inventory.id, products.id) is None
    assert effective_levels(integration_db, member).department_ids() == frozenset({inventory.id})


def test_guest_is_capped_at_read(integration_db: Session) -> None:
    guest = add_user(integration_db, role=UserRole.GUEST)
    inventory = add_department(integration_db)
    products = add_module(integration_db, inventory)
    make_group_access(integration_db, [guest], inventory, level=MANAGE)

    assert level_for(integration_db, guest, inventory.id, products.id) is READ
    assert level_for(integration_db, guest, inventory.id) is READ
    assert allowed_module_ids(integration_db, guest, READ) == frozenset({products.id})
    assert allowed_module_ids(integration_db, guest, WRITE) == frozenset()


@pytest.mark.parametrize("state", ["disabled", "pending", "expired", "deleted"])
def test_inactive_accounts_get_nothing(integration_db: Session, state: str) -> None:
    role = UserRole.ADMIN if state == "deleted" else UserRole.MEMBER
    user = add_user(
        integration_db,
        role=role,
        status=UserStatus.DISABLED if state == "disabled" else UserStatus.ACTIVE,
    )
    if state == "pending":
        user.status = UserStatus.PENDING.value
        membership_of(integration_db, user.id).invitation_sent_at = utc_now()
    if state == "expired":
        membership_of(integration_db, user.id).expires_at = (
            datetime.now(UTC) - timedelta(minutes=1)
        )
    if state == "deleted":
        user.is_deleted = True
        user.deleted_at = utc_now()
    integration_db.flush()
    inventory = add_department(integration_db)
    products = add_module(integration_db, inventory)
    make_group_access(integration_db, [user], inventory, level=MANAGE)

    assert level_for(integration_db, user, inventory.id, products.id) is None
    assert allowed_module_ids(integration_db, user, READ) == frozenset()


def test_deleted_groups_memberships_and_rows_give_nothing(integration_db: Session) -> None:
    member = add_user(integration_db)
    inventory = add_department(integration_db)
    products = add_module(integration_db, inventory)
    deleted_group = integration_db.get(
        Group, make_group_access(integration_db, [member], inventory, level=MANAGE).group_id
    )
    assert deleted_group is not None
    deleted_group.is_deleted = True
    deleted_group.deleted_at = utc_now()
    deleted_row = make_group_access(integration_db, [member], inventory, level=WRITE)
    deleted_row.is_deleted = True
    deleted_row.deleted_at = utc_now()
    removed = make_group_access(integration_db, [member], inventory, level=READ)
    for membership in integration_db.scalars(
        select(GroupMember).where(GroupMember.group_id == removed.group_id)
    ):
        membership.is_deleted = True
        membership.deleted_at = utc_now()
    integration_db.flush()

    assert level_for(integration_db, member, inventory.id, products.id) is None


@pytest.mark.parametrize("removed", ["access", "membership"])
def test_resolution_sees_access_removed_in_the_same_transaction(
    integration_db: Session, removed: str,
) -> None:
    member = add_user(integration_db)
    department = add_department(integration_db)
    module = add_module(integration_db, department)
    grant = make_group_access(integration_db, [member], department, level=READ)
    membership = membership_of(integration_db, member.id)
    assert effective_levels(integration_db, member).module_ids(READ) == frozenset({module.id})

    if removed == "access":
        integration_db.delete(grant)
    else:
        membership.status = UserStatus.DISABLED.value

    assert effective_levels(integration_db, member).module_ids(READ) == frozenset()


@pytest.mark.parametrize(
    "state", ["none", "pending", "disabled", "deleted", "multiple", "unaccepted", "demoted"]
)
def test_resolution_refuses_absent_ambiguous_or_stale_authority(integration_owner_db, state):
    db = integration_owner_db
    user, membership = create_member(db, create_organization(db), "admin")
    if state == "multiple":
        create_member(
            db, create_organization(db), "member", user=user,
            expires_at=utc_now() - timedelta(minutes=1),
        )
    elif state == "none":
        db.connection().execute(
            Membership.__table__.delete().where(Membership.id == membership.id)
        )
    else:
        values = (
            {"is_deleted": True} if state == "deleted" else
            {"invitation_sent_at": utc_now()} if state == "unaccepted" else
            {"role": "member"} if state == "demoted" else {"status": state}
        )
        db.connection().execute(
            Membership.__table__.update().where(Membership.id == membership.id).values(**values)
        )
    assert effective_levels(db, user).unrestricted is False
    assert allowed_module_ids(db, user, READ) == frozenset()


@pytest.mark.parametrize("entity", ["account", "membership"])
def test_resolution_flushes_pending_changes_without_discarding_them(integration_owner_db, entity):
    db = integration_owner_db
    user = add_user(db)
    membership = membership_of(db, user.id)
    department = add_department(db)
    module = add_module(db, department)
    make_group_access(db, [user], department, level=READ)
    row, field, changed = (
        (user, "display_name", "Pending profile change") if entity == "account" else
        (membership, "expires_at", utc_now() + timedelta(days=1))
    )
    setattr(row, field, changed)
    assert allowed_module_ids(db, user, READ) == frozenset({module.id})
    assert row not in db.dirty
    assert getattr(row, field) == changed
    assert db.connection().scalar(
        select(getattr(type(row), field)).where(type(row).id == row.id)
    ) == changed
