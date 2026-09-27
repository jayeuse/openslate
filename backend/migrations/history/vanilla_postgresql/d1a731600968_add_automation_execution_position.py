"""add automation execution position

Revision ID: d1a731600968
Revises: 5147066a0b3a
Create Date: 2026-09-22 01:01:33.087706
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d1a731600968"
down_revision: str | None = "5147066a0b3a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "published_automation_definitions",
        sa.Column("execution_position", sa.Integer(), server_default=sa.text("0"), nullable=False),
    )
    op.create_check_constraint(
        "ck_published_automation_execution_position",
        "published_automation_definitions",
        "execution_position >= 0",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_published_automation_execution_position",
        "published_automation_definitions",
    )
    op.drop_column("published_automation_definitions", "execution_position")
