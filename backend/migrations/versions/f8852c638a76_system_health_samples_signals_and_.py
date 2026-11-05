"""system health samples signals and server errors

Revision ID: f8852c638a76
Revises: e46611902f25
Create Date: 2026-11-05 00:40:45.467876
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "f8852c638a76"
down_revision: str | None = "e46611902f25"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SIGNAL_KEYS = (
    "record_triggers",
    "report_scheduling",
    "comms_jobs",
    "provider_signout",
    "email_accepted",
    "email_failed",
)

# Deletes samples and server errors older than 30 days, and server errors beyond the newest
# 50,000, in batches of at most 5,000. Every API process calls it hourly; the try-lock lets
# one run at a time. It writes no proof event: these rows are diagnostics, not security data.
RETENTION_FUNCTION = r"""
CREATE OR REPLACE FUNCTION public.retain_system_health() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET "TimeZone" TO 'UTC'
    AS $$
        DECLARE
            cutoff timestamptz;
            batch integer;
            total_deleted integer := 0;
        BEGIN
            IF NOT pg_catalog.pg_try_advisory_xact_lock(
                pg_catalog.hashtextextended('slateops:system-health-retention', 0)
            ) THEN
                RETURN 0;
            END IF;
            cutoff := pg_catalog.transaction_timestamp() - pg_catalog.make_interval(days => 30);
            LOOP
                DELETE FROM public.system_health_samples AS s
                 WHERE s.sampled_at IN (
                    SELECT o.sampled_at FROM public.system_health_samples AS o
                     WHERE o.sampled_at < cutoff ORDER BY o.sampled_at LIMIT 5000
                 );
                GET DIAGNOSTICS batch = ROW_COUNT;
                total_deleted := total_deleted + batch;
                EXIT WHEN batch < 5000;
            END LOOP;
            LOOP
                DELETE FROM public.server_errors AS e
                 WHERE e.request_id IN (
                    SELECT o.request_id FROM public.server_errors AS o
                     WHERE o.occurred_at < cutoff ORDER BY o.occurred_at LIMIT 5000
                 );
                GET DIAGNOSTICS batch = ROW_COUNT;
                total_deleted := total_deleted + batch;
                EXIT WHEN batch < 5000;
            END LOOP;
            LOOP
                DELETE FROM public.server_errors AS e
                 WHERE e.request_id IN (
                    SELECT o.request_id FROM public.server_errors AS o
                     ORDER BY o.occurred_at DESC, o.request_id DESC OFFSET 50000 LIMIT 5000
                 );
                GET DIAGNOSTICS batch = ROW_COUNT;
                total_deleted := total_deleted + batch;
                EXIT WHEN batch < 5000;
            END LOOP;
            RETURN total_deleted;
        END;
        $$;
ALTER FUNCTION public.retain_system_health() OWNER TO slateops_owner;
REVOKE ALL ON FUNCTION public.retain_system_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.retain_system_health() TO slateops_app;
"""

# server_errors follows security_events: a bound transaction reads its organization's rows and
# the rows of no organization. Unlike security_events, an insert must match the binding too.
BOUND = "(SELECT (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid)"
ROW_SECURITY = (
    "ALTER TABLE public.server_errors ENABLE ROW LEVEL SECURITY",
    "CREATE POLICY organization_rows ON public.server_errors FOR SELECT TO slateops_app "
    f"USING ((org_id IS NULL) OR (org_id = {BOUND}))",
    "CREATE POLICY organization_appends ON public.server_errors FOR INSERT TO slateops_app "
    f"WITH CHECK ((org_id IS NULL) OR (org_id = {BOUND}))",
)

# The installation's default privileges grant every new table full DML; narrow each one.
PRIVILEGES = (
    "REVOKE ALL ON TABLE public.system_health_samples, public.system_health_signals, "
    "public.server_errors FROM slateops_app",
    "GRANT SELECT, INSERT ON TABLE public.system_health_samples TO slateops_app",
    "GRANT SELECT, UPDATE ON TABLE public.system_health_signals TO slateops_app",
    "GRANT SELECT, INSERT ON TABLE public.server_errors TO slateops_app",
)


def upgrade() -> None:
    op.create_table(
        "system_health_samples",
        sa.Column("sampled_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("data_status", sa.Text(), nullable=False),
        sa.Column("data_ms", sa.Integer(), nullable=True),
        sa.Column("signing_in_status", sa.Text(), nullable=False),
        sa.Column("signing_in_ms", sa.Integer(), nullable=True),
        sa.Column("files_status", sa.Text(), nullable=False),
        sa.Column("files_ms", sa.Integer(), nullable=True),
        sa.Column("email_status", sa.Text(), nullable=False),
        sa.Column("database_bytes", sa.BigInteger(), nullable=True),
        sa.CheckConstraint(
            "data_status IN ('working','not_working','not_set_up') "
            "AND signing_in_status IN ('working','not_working','not_set_up') "
            "AND files_status IN ('working','not_working','not_set_up')",
            name="ck_system_health_samples_part_status",
        ),
        sa.CheckConstraint(
            "email_status IN ('working','not_working','set_up','not_set_up')",
            name="ck_system_health_samples_email_status",
        ),
        sa.CheckConstraint(
            "(data_ms IS NULL OR data_ms >= 0) AND (signing_in_ms IS NULL OR signing_in_ms >= 0) "
            "AND (files_ms IS NULL OR files_ms >= 0)",
            name="ck_system_health_samples_ms",
        ),
        sa.CheckConstraint(
            "EXTRACT(SECOND FROM sampled_at) = 0", name="ck_system_health_samples_minute"
        ),
        sa.CheckConstraint(
            "database_bytes IS NULL OR database_bytes >= 0",
            name="ck_system_health_samples_database_bytes",
        ),
        sa.PrimaryKeyConstraint("sampled_at", name=op.f("system_health_samples_pkey")),
    )
    op.create_table(
        "system_health_signals",
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "key IN ('record_triggers','report_scheduling','comms_jobs','provider_signout',"
            "'email_accepted','email_failed')",
            name="ck_system_health_signals_key",
        ),
        sa.PrimaryKeyConstraint("key", name=op.f("system_health_signals_pkey")),
    )
    op.create_table(
        "server_errors",
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column(
            "occurred_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("status", sa.SmallInteger(), nullable=False),
        sa.Column("method", sa.Text(), nullable=False),
        sa.Column("route", sa.Text(), nullable=False),
        sa.Column("org_id", sa.UUID(), nullable=True),
        sa.CheckConstraint("method ~ '^[A-Z]{3,7}$'", name="ck_server_errors_method"),
        sa.CheckConstraint("char_length(route) <= 200", name="ck_server_errors_route"),
        sa.CheckConstraint("status BETWEEN 500 AND 599", name="ck_server_errors_status"),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_server_errors_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("request_id", name=op.f("server_errors_pkey")),
    )
    op.create_index("ix_server_errors_occurred_at", "server_errors", ["occurred_at"], unique=False)
    op.create_index(
        "ix_server_errors_org_occurred_at", "server_errors", ["org_id", "occurred_at"], unique=False
    )
    for statement in (RETENTION_FUNCTION, *ROW_SECURITY, *PRIVILEGES):
        op.execute(statement)
    # Heartbeats and email outcomes only ever update these six rows.
    op.execute(
        "INSERT INTO public.system_health_signals (key) VALUES "
        + ", ".join(f"('{key}')" for key in SIGNAL_KEYS)
    )


def downgrade() -> None:
    # Destructive: health samples, signals and the server error log are dropped.
    op.execute("DROP FUNCTION public.retain_system_health()")
    op.drop_index("ix_server_errors_org_occurred_at", table_name="server_errors")
    op.drop_index("ix_server_errors_occurred_at", table_name="server_errors")
    op.drop_table("server_errors")
    op.drop_table("system_health_signals")
    op.drop_table("system_health_samples")
