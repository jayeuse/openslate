"""Create the security event append-only store.

Revision ID: 20260902_0016
Revises: 20260831_0015
Create Date: 2026-09-02 12:47:51.884795
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260902_0016"
down_revision: str | None = '20260831_0015'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "security_events",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_type", sa.String(length=100), nullable=False),
        sa.Column("outcome", sa.String(length=20), nullable=False),
        sa.Column("source", sa.String(length=100), nullable=False),
        sa.Column("operation_id", sa.UUID(), nullable=False),
        sa.Column("actor_id", sa.UUID(), nullable=True),
        sa.Column("subject_id", sa.UUID(), nullable=True),
        sa.Column(
            "labels",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("fingerprint", sa.String(length=128), nullable=True),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("request_id", sa.UUID(), nullable=True),
        sa.Column("request_method", sa.String(length=10), nullable=True),
        sa.Column("request_path", sa.Text(), nullable=True),
        sa.Column(
            "metadata",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "outcome IN ('attempt', 'success', 'denied', 'failure', 'partial')",
            name="ck_security_events_outcome",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("security_events_pkey")),
    )
    op.create_foreign_key(
        "fk_security_events_actor_id_users",
        "security_events",
        "users",
        ["actor_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_foreign_key(
        "fk_security_events_subject_id_users",
        "security_events",
        "users",
        ["subject_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_security_events_occurred_at_id",
        "security_events",
        ["occurred_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_security_events_operation_id",
        "security_events",
        ["operation_id"],
        unique=False,
    )

    op.execute(
        sa.text(
            """
            REVOKE ALL PRIVILEGES ON TABLE public.security_events
                FROM PUBLIC, anon, authenticated, service_role;
            GRANT SELECT, INSERT ON TABLE public.security_events TO openslate_app;

            ALTER TABLE public.security_events ENABLE ROW LEVEL SECURITY;

            DROP POLICY IF EXISTS openslate_app_security_events_select
                ON public.security_events;
            CREATE POLICY openslate_app_security_events_select
                ON public.security_events AS PERMISSIVE FOR SELECT
                TO openslate_app USING (true);

            DROP POLICY IF EXISTS openslate_app_security_events_insert
                ON public.security_events;
            CREATE POLICY openslate_app_security_events_insert
                ON public.security_events AS PERMISSIVE FOR INSERT
                TO openslate_app WITH CHECK (true);
            """
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            DROP POLICY IF EXISTS openslate_app_security_events_select
                ON public.security_events;
            DROP POLICY IF EXISTS openslate_app_security_events_insert
                ON public.security_events;
            REVOKE ALL PRIVILEGES ON TABLE public.security_events
                FROM PUBLIC, anon, authenticated, service_role, openslate_app;
            """
        )
    )
    op.drop_index("ix_security_events_operation_id", table_name="security_events")
    op.drop_index("ix_security_events_occurred_at_id", table_name="security_events")
    op.drop_table("security_events")
