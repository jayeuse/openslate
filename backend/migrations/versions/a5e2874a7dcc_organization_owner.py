"""organization owner

Revision ID: a5e2874a7dcc
Revises: f5a100021193
Create Date: 2026-10-17 08:00:00.000000

Each organization has one owner: the account that created it. The owner alone
changes the organization's sensitive security settings; other administrators do
the rest (owner decision, 2026-10-16). Existing organizations take their earliest
administrator as owner.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a5e2874a7dcc"
down_revision: str | None = "f5a100021193"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("organizations", sa.Column("owner_user_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f("fk_organizations_owner_user_id_users"), "organizations", "users",
        ["owner_user_id"], ["id"], ondelete="SET NULL",
    )
    op.execute(
        """
        UPDATE public.organizations AS o SET owner_user_id = (
            SELECT m.user_id FROM public.memberships AS m
            WHERE m.org_id = o.id AND m.role = 'admin' AND m.is_deleted IS FALSE
            ORDER BY m.created_at, m.id LIMIT 1
        )
        """
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_organizations_owner_user_id_users"), "organizations", type_="foreignkey"
    )
    op.drop_column("organizations", "owner_user_id")
