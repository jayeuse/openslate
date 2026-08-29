"""Add lifecycle confirmation and rate-limit persistence foundations."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260829_0013"
down_revision = "20260819_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "audit_logs",
        sa.Column("actor_label", sa.String(length=100), nullable=True),
    )
    op.add_column(
        "audit_logs",
        sa.Column("note", sa.Text(), nullable=True),
    )

    op.create_table(
        "lifecycle_confirmation_challenges",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "actor_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("operation", sa.String(length=20), nullable=False),
        sa.Column("target_type", sa.String(length=50), nullable=False),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("impact_digest", sa.String(length=128), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False, unique=True),
        sa.Column("failed_attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "status",
            sa.String(length=20),
            server_default=sa.text("'pending'"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "verification_lease_id", postgresql.UUID(as_uuid=True), unique=True, nullable=True
        ),
        sa.Column(
            "verification_lease_expires_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.CheckConstraint(
            "operation IN ('close', 'purge')",
            name="ck_lifecycle_challenges_operation",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'verifying', 'consumed', 'expired', 'invalidated', 'exhausted')",
            name="ck_lifecycle_challenges_status",
        ),
        sa.CheckConstraint(
            "failed_attempts >= 0 AND failed_attempts <= 5",
            name="ck_lifecycle_challenges_failed_attempts_nonnegative",
        ),
        sa.CheckConstraint(
            "expires_at > created_at AND expires_at <= created_at + interval '5 minutes'",
            name="ck_lifecycle_challenges_five_minute_expiry",
        ),
        sa.CheckConstraint(
            "length(btrim(target_type)) > 0",
            name="ck_lifecycle_challenges_target_type_nonempty",
        ),
        sa.CheckConstraint(
            "length(token_hash) = 64 AND token_hash ~ '^[0-9a-f]{64}$'",
            name="ck_lifecycle_challenges_token_hash_sha256",
        ),
        sa.CheckConstraint(
            "length(btrim(impact_digest)) > 0",
            name="ck_lifecycle_challenges_impact_digest_nonempty",
        ),
    )

    op.create_table(
        "lifecycle_rate_limit_buckets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "actor_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
            unique=True,
        ),
        sa.Column("attempt_count", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("window_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("blocked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "attempt_count >= 0 AND attempt_count <= 5",
            name="ck_lifecycle_buckets_attempt_count_nonnegative",
        ),
        sa.CheckConstraint(
            "window_expires_at > window_started_at AND window_expires_at <= "
            "window_started_at + interval '15 minutes'",
            name="ck_lifecycle_buckets_fifteen_minute_window",
        ),
    )

    op.create_table(
        "lifecycle_rate_limit_failures",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False),
        sa.Column(
            "actor_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Index(
            "ix_lifecycle_rate_limit_failures_actor_occurred",
            "actor_id",
            "occurred_at",
        ),
    )

    op.execute(
        sa.text(
            """
            WITH migration_request AS (
                SELECT gen_random_uuid() AS request_id
            ), targets AS (
                SELECT 'departments' AS entity_type, id
                  FROM departments
                 WHERE is_deleted = true
                UNION ALL
                SELECT 'modules' AS entity_type, id
                  FROM modules
                 WHERE is_deleted = true
                UNION ALL
                SELECT 'fields' AS entity_type, id
                  FROM fields
                 WHERE is_deleted = true
            )
            INSERT INTO audit_logs (
                id, created_at, performed_by, action, entity_type, entity_id,
                before, after, request_id, request_method, request_path,
                actor_label, note
            )
            SELECT gen_random_uuid(), CURRENT_TIMESTAMP, NULL, 'update', targets.entity_type,
                   targets.id, NULL, jsonb_build_object('status', 'closed'),
                   migration_request.request_id, 'MIGRATION',
                   '/migrations/20260829_0013', 'system_migration',
                   'reclassified as Closed on rollout; prior closure history unknown'
              FROM targets
              CROSS JOIN migration_request;
            """
        )
    )

    op.execute(
        sa.text(
            """
            REVOKE ALL PRIVILEGES ON TABLE
                public.lifecycle_confirmation_challenges,
                public.lifecycle_rate_limit_buckets
                FROM PUBLIC, anon, authenticated, service_role;
            GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
                public.lifecycle_confirmation_challenges TO openslate_app;
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
                 public.lifecycle_rate_limit_buckets TO openslate_app;
             GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
                 public.lifecycle_rate_limit_failures TO openslate_app;
            """
        )
    )

    for table_name in (
        "lifecycle_confirmation_challenges",
        "lifecycle_rate_limit_buckets",
        "lifecycle_rate_limit_failures",
    ):
        op.execute(
            sa.text(
                f"""
                ALTER TABLE public.{table_name} ENABLE ROW LEVEL SECURITY;
                DROP POLICY IF EXISTS openslate_app_{table_name}_select
                    ON public.{table_name};
                CREATE POLICY openslate_app_{table_name}_select
                    ON public.{table_name} AS PERMISSIVE FOR SELECT
                    TO openslate_app USING (true);
                DROP POLICY IF EXISTS openslate_app_{table_name}_insert
                    ON public.{table_name};
                CREATE POLICY openslate_app_{table_name}_insert
                    ON public.{table_name} AS PERMISSIVE FOR INSERT
                    TO openslate_app WITH CHECK (true);
                DROP POLICY IF EXISTS openslate_app_{table_name}_update
                    ON public.{table_name};
                CREATE POLICY openslate_app_{table_name}_update
                    ON public.{table_name} AS PERMISSIVE FOR UPDATE
                    TO openslate_app USING (true) WITH CHECK (true);
                DROP POLICY IF EXISTS openslate_app_{table_name}_delete
                    ON public.{table_name};
                CREATE POLICY openslate_app_{table_name}_delete
                    ON public.{table_name} AS PERMISSIVE FOR DELETE
                    TO openslate_app USING (true);
                """
            )
        )


def downgrade() -> None:
    op.execute(
        sa.text(
            """
            DELETE FROM audit_logs
             WHERE actor_label = 'system_migration'
               AND note = 'reclassified as Closed on rollout; prior closure history unknown'
               AND request_path = '/migrations/20260829_0013';
            """
        )
    )
    # The original uncommitted 0013 may already have been applied locally
    # without this event table.  IF EXISTS keeps that downgrade reversible.
    op.execute(sa.text("DROP TABLE IF EXISTS public.lifecycle_rate_limit_failures"))
    for table_name in (
        "lifecycle_rate_limit_buckets",
        "lifecycle_confirmation_challenges",
    ):
        op.execute(
            sa.text(
                f"""
                DROP POLICY IF EXISTS openslate_app_{table_name}_select
                    ON public.{table_name};
                DROP POLICY IF EXISTS openslate_app_{table_name}_insert
                    ON public.{table_name};
                DROP POLICY IF EXISTS openslate_app_{table_name}_update
                    ON public.{table_name};
                DROP POLICY IF EXISTS openslate_app_{table_name}_delete
                    ON public.{table_name};
                REVOKE ALL PRIVILEGES ON TABLE public.{table_name}
                    FROM PUBLIC, anon, authenticated, service_role, openslate_app;
                """
            )
        )
    op.drop_table("lifecycle_rate_limit_buckets")
    op.drop_table("lifecycle_confirmation_challenges")
    op.drop_column("audit_logs", "note")
    op.drop_column("audit_logs", "actor_label")
