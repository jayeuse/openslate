"""add active organization to identity sessions

Revision ID: ffe73dc0240d
Revises: 8db89b6c6c35
Create Date: 2026-10-16 05:42:18.086030
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "ffe73dc0240d"
down_revision: str | None = "8db89b6c6c35"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("identity_sessions", sa.Column("active_org_id", sa.UUID(), nullable=True))
    op.create_foreign_key(
        op.f("fk_identity_sessions_active_org_id_organizations"), "identity_sessions",
        "organizations", ["active_org_id"], ["id"], ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_identity_sessions_active_org_id_organizations"), "identity_sessions",
        type_="foreignkey",
    )
    op.drop_column("identity_sessions", "active_org_id")
