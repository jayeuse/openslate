"""Add shared audit columns and migrate user IDs to UUIDv7.

Revision ID: 20260819_0002
Revises: 20260819_0001
Create Date: 2026-08-19
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from uuid6 import uuid7

revision: str = "20260819_0002"
down_revision: str | None = "20260819_0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()

    op.add_column(
        "users",
        sa.Column("new_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    existing_ids = connection.execute(sa.text("SELECT id FROM users ORDER BY id")).scalars().all()
    for old_id in existing_ids:
        connection.execute(
            sa.text("UPDATE users SET new_id = :new_id WHERE id = :old_id"),
            {"new_id": uuid7(), "old_id": old_id},
        )
    op.alter_column("users", "new_id", nullable=False)

    op.drop_constraint("users_pkey", "users", type_="primary")
    op.drop_column("users", "id")
    op.alter_column("users", "new_id", new_column_name="id")
    op.create_primary_key("users_pkey", "users", ["id"])

    op.add_column("users", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "users",
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column(
        "users",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
    )
    op.add_column("users", sa.Column("performed_by", sa.String(), nullable=True))


def downgrade() -> None:
    raise NotImplementedError(
        "The UUIDv7 primary-key migration is intentionally forward-only; "
        "restore a database backup to downgrade."
    )
