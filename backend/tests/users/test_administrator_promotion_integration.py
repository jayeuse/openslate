"""A person who becomes an administrator leaves every group in the same audited change.

Administrators have access everywhere and are never group members (see
``replace_group_members``), so a promotion removes the memberships instead of
leaving rows that the group editor would refuse to save.
"""

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

import app.systems.access.users.account_operations as account_operations
from app.systems.access.policy.models import AccessLevel, Group, GroupMember
from app.systems.access.users.models import User, UserRole
from app.systems.access.users.schemas import UserUpdate
from app.systems.manage.audit.context import set_audit_actor
from app.systems.manage.audit.models import AuditLog
from tests.rbac.support import add_department, add_user, make_group_access

pytestmark = pytest.mark.integration


def test_promoting_a_member_removes_their_group_memberships_with_an_audit_record(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    inventory = add_department(db)
    finance = add_department(db)
    admin = add_user(db, "promotion-admin", role=UserRole.ADMIN)
    member = add_user(db, "promotion-member")
    colleague = add_user(db, "promotion-colleague")
    clerks = db.get(
        Group,
        make_group_access(db, [member, colleague], inventory, level=AccessLevel.WRITE).group_id,
    )
    readers = db.get(Group, make_group_access(db, [member], finance).group_id)
    assert clerks is not None and readers is not None
    revisions = {clerks.id: clerks.revision, readers.id: readers.revision}
    removed = {
        row.id
        for row in db.scalars(select(GroupMember).where(GroupMember.user_id == member.id)).all()
    }
    assert len(removed) == 2
    db.commit()
    set_audit_actor(db, admin.id)

    result = account_operations.update_user(
        member.id, UserUpdate(role=UserRole.ADMIN), User(id=admin.id), db
    )

    assert result.role == UserRole.ADMIN.value
    assert db.scalars(select(GroupMember).where(GroupMember.user_id == member.id)).all() == []
    assert db.scalars(
        select(GroupMember.user_id).where(GroupMember.group_id == clerks.id)
    ).all() == [colleague.id]
    for group in (clerks, readers):
        db.refresh(group)
        assert group.revision == revisions[group.id] + 1
        assert group.performed_by == admin.id
    audited = db.scalars(
        select(AuditLog).where(
            AuditLog.entity_type == "group_members",
            AuditLog.action == "delete",
            AuditLog.entity_id.in_(removed),
        )
    ).all()
    assert {row.entity_id for row in audited} == removed
    assert {row.performed_by for row in audited} == {admin.id}


def test_a_role_change_that_does_not_promote_keeps_group_memberships(
    integration_owner_db: Session,
) -> None:
    db = integration_owner_db
    department = add_department(db)
    admin = add_user(db, "keep-admin", role=UserRole.ADMIN)
    member = add_user(db, "keep-member")
    make_group_access(db, [member], department)
    db.commit()
    set_audit_actor(db, admin.id)

    account_operations.update_user(member.id, UserUpdate(job_title="Clerk"), User(id=admin.id), db)

    assert len(db.scalars(select(GroupMember).where(GroupMember.user_id == member.id)).all()) == 1
