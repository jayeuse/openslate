"""Create departments, modules, fields, and records."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260819_0005"
down_revision: str | None = "20260819_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def shared_columns() -> list[sa.Column]:
    return [
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column("performed_by", postgresql.UUID(as_uuid=True), nullable=True),
    ]


def add_shared_constraints(table_name: str) -> None:
    op.create_primary_key(f"{table_name}_pkey", table_name, ["id"])
    op.create_foreign_key(
        f"fk_{table_name}_performed_by_users",
        table_name,
        "users",
        ["performed_by"],
        ["id"],
        ondelete="SET NULL",
    )


def upgrade() -> None:
    op.create_table(
        "departments",
        *shared_columns(),
        sa.Column("department_name", sa.String(length=150), nullable=False),
    )
    add_shared_constraints("departments")
    op.create_index(
        "uq_departments_name_active",
        "departments",
        ["department_name"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )

    op.create_table(
        "modules",
        *shared_columns(),
        sa.Column("department_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("module_name", sa.String(length=150), nullable=False),
    )
    add_shared_constraints("modules")
    op.create_foreign_key(
        "fk_modules_department_id_departments",
        "modules",
        "departments",
        ["department_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index("ix_modules_department_id", "modules", ["department_id"])
    op.create_index(
        "uq_modules_department_name_active",
        "modules",
        ["department_id", "module_name"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )

    op.create_table(
        "fields",
        *shared_columns(),
        sa.Column("module_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(length=150), nullable=False),
        sa.Column("type", sa.String(length=20), nullable=False),
        sa.Column("required", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "config",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.CheckConstraint("position >= 0", name="ck_fields_position_nonnegative"),
    )
    add_shared_constraints("fields")
    op.create_foreign_key(
        "fk_fields_module_id_modules",
        "fields",
        "modules",
        ["module_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index("ix_fields_module_id", "fields", ["module_id"])
    op.create_index(
        "uq_fields_module_name_active",
        "fields",
        ["module_id", "name"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index(
        "uq_fields_module_position_active",
        "fields",
        ["module_id", "position"],
        unique=True,
        postgresql_where=sa.text("is_deleted = false"),
    )

    op.create_table(
        "records",
        *shared_columns(),
        sa.Column("module_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "data",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    add_shared_constraints("records")
    op.create_foreign_key(
        "fk_records_module_id_modules",
        "records",
        "modules",
        ["module_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_index("ix_records_module_id", "records", ["module_id"])


def downgrade() -> None:
    raise NotImplementedError("Restore a database backup to downgrade this forward-only migration.")
