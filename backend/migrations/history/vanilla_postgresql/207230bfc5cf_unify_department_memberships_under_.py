"""Unify department memberships under the Access-owned table.

Revision ID: 207230bfc5cf
Revises: 997ba6cad7ac
Create Date: 2026-09-24 15:25:50.496105
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "207230bfc5cf"
down_revision: str | None = "997ba6cad7ac"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Access wins when both branches recorded the same membership. Only active
    # legacy links add missing pairs; their old table has no primary concept.
    op.execute(
        sa.text(
            "INSERT INTO user_departments "
            "(id, user_id, department_id, is_primary, created_at, updated_at, performed_by) "
            "SELECT id, user_id, department_id, false, created_at, updated_at, performed_by "
            "FROM user_department_memberships "
            "WHERE is_deleted = false AND deleted_at IS NULL "
            "ON CONFLICT (user_id, department_id) DO NOTHING"
        )
    )
    op.drop_index(
        op.f("ix_user_department_memberships_department_id"),
        table_name="user_department_memberships",
    )
    op.drop_table("user_department_memberships")


def downgrade() -> None:
    op.create_table(
        "user_department_memberships",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("department_id", sa.UUID(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), nullable=True),
        sa.ForeignKeyConstraint(
            ["department_id"],
            ["departments.id"],
            name=op.f("fk_user_department_memberships_department_id_departments"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_user_department_memberships_performed_by_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_user_department_memberships_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("user_department_memberships_pkey")),
        sa.UniqueConstraint(
            "user_id", "department_id", name="uq_user_department_memberships_user_department"
        ),
    )
    op.create_index(
        op.f("ix_user_department_memberships_department_id"),
        "user_department_memberships",
        ["department_id"],
        unique=False,
    )
    op.execute(
        sa.text(
            "INSERT INTO user_department_memberships "
            "(id, user_id, department_id, created_at, updated_at, performed_by) "
            "SELECT id, user_id, department_id, created_at, updated_at, performed_by "
            "FROM user_departments WHERE is_deleted = false AND deleted_at IS NULL"
        )
    )
