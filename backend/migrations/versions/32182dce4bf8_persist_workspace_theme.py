"""persist workspace theme

Revision ID: 32182dce4bf8
Revises: a16df813658f
Create Date: 2026-10-06 08:57:20.453087
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "32182dce4bf8"
down_revision: str | None = "a16df813658f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The server default also supplies Slate for the existing singleton.
    op.add_column(
        "workspace_profiles",
        sa.Column("theme", sa.String(length=16), server_default=sa.text("'slate'"), nullable=False),
    )
    op.create_check_constraint(
        "ck_workspace_profiles_theme",
        "workspace_profiles",
        "theme IN ('slate', 'whiteboard', 'triplicate', 'stockroom')",
    )


def downgrade() -> None:
    op.drop_constraint("ck_workspace_profiles_theme", "workspace_profiles", type_="check")
    op.drop_column("workspace_profiles", "theme")
