"""drop audit actor foreign key

`audit_logs.performed_by` loses `fk_audit_logs_performed_by_users` (decision D21). Its
`ON DELETE SET NULL` rewrote audit rows of every chain whenever a person was removed, which
a sealed hour would report as a change. A removed person's id now stays with no user row,
as `security_events.actor_id` already does; the readers show no name for it.

Dropping the parent's key drops the clone on each partition. The statement takes ACCESS
EXCLUSIVE on `audit_logs` and a lock on `users`, so a running API makes the revision fail
after `lock_timeout` with no change.

Downgrade changes data: before it adds the key back, it sets `performed_by` to NULL in each
row whose person no longer exists, which is what `SET NULL` would have done. The seal
revision's downgrade runs first and drops every seal, so no seal disagrees afterwards.

Revision ID: 635864bb4a1c
Revises: f43c7d0ee160
Create Date: 2026-11-07 19:12:47.746942
"""
from collections.abc import Sequence

from alembic import op

revision: str = "635864bb4a1c"
down_revision: str | None = "f43c7d0ee160"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("fk_audit_logs_performed_by_users", "audit_logs", type_="foreignkey")


def downgrade() -> None:
    op.execute(
        "UPDATE public.audit_logs AS audit SET performed_by = NULL "
        "WHERE audit.performed_by IS NOT NULL AND NOT EXISTS "
        "(SELECT FROM public.users WHERE users.id = audit.performed_by)"
    )
    op.create_foreign_key(
        "fk_audit_logs_performed_by_users",
        "audit_logs",
        "users",
        ["performed_by"],
        ["id"],
        ondelete="SET NULL",
    )
