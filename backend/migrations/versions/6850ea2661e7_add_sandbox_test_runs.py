"""add sandbox test runs

Revision ID: 6850ea2661e7
Revises: 7569e88d45cd
Create Date: 2026-09-21 20:45:34.034724
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "6850ea2661e7"
down_revision: str | None = "7569e88d45cd"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sandbox_test_runs",
        sa.Column("document_id", sa.UUID(), nullable=False),
        sa.Column("document_revision", sa.Integer(), nullable=False),
        sa.Column("document_hash", sa.String(length=64), nullable=False),
        sa.Column("module_id", sa.String(length=1_000), nullable=False),
        sa.Column("input_values", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("event", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("automation_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("result", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("result_byte_count", sa.Integer(), nullable=False),
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "is_deleted",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), nullable=True),
        sa.CheckConstraint(
            "document_revision > 0",
            name="ck_sandbox_test_runs_document_revision_positive",
        ),
        sa.CheckConstraint(
            "result_byte_count >= 0",
            name="ck_sandbox_test_runs_result_byte_count_nonnegative",
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["sandbox_documents.id"],
            name=op.f("fk_sandbox_test_runs_document_id_sandbox_documents"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("sandbox_test_runs_pkey")),
    )
    op.create_foreign_key(
        "fk_sandbox_test_runs_performed_by_users",
        "sandbox_test_runs",
        "users",
        ["performed_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_sandbox_test_runs_document_created",
        "sandbox_test_runs",
        ["document_id", "created_at", "id"],
        unique=False,
    )
    op.execute(
        sa.text(
            "GRANT SELECT, INSERT, UPDATE ON TABLE public.sandbox_test_runs TO openslate_runtime"
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "REVOKE SELECT, INSERT, UPDATE ON TABLE public.sandbox_test_runs FROM openslate_runtime"
        )
    )
    op.drop_constraint(
        "fk_sandbox_test_runs_performed_by_users",
        "sandbox_test_runs",
        type_="foreignkey",
    )
    op.drop_index(
        "ix_sandbox_test_runs_document_created",
        table_name="sandbox_test_runs",
    )
    op.drop_table("sandbox_test_runs")
