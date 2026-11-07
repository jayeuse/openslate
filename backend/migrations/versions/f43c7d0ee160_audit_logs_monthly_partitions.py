"""audit_logs monthly partitions

Partition `audit_logs` by month on `created_at` (decisions D4 and D20, plan step 2.4).

The first statement takes ACCESS EXCLUSIVE on the table, so a running API makes the revision
fail after `lock_timeout` with no change. One transaction moves every row, and a failed
check restores everything. Keys and indexes are built last, once, on loaded data.

The primary key becomes `(id, created_at)`, because a key on a partitioned table must hold
the partition column. `(org_id, created_at, id)` replaces `uq_audit_logs_org_id_id`: it is
the index that row-level security reads. Department, actor and request indexes become
partial.

A partition has none of the parent's grants or policies when a statement names it, and the
default privileges of `slateops_owner` give `slateops_app` full rights on each new table. So
every partition loses those rights in the transaction that creates it, and has row-level
security on with no policy. Only `audit_logs_default` and `create_audit_partition` create
partitions. Neither Alembic nor `alembic check` compares any of this:
`tests/migrations/test_audit_partition_catalog.py` owns it.

Revision ID: f43c7d0ee160
Revises: 4d8efe5fde6f
Create Date: 2026-11-07 12:45:27.896700
"""
import logging
import time
from collections.abc import Sequence
from datetime import datetime, timedelta

import sqlalchemy as sa
from alembic import op

revision: str = "f43c7d0ee160"
down_revision: str | None = "4d8efe5fde6f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

log = logging.getLogger("alembic.runtime.migration")

COLUMNS = ", ".join(
    f'"{column}"'
    for column in (
        "org_id",
        "id",
        "created_at",
        "performed_by",
        "action",
        "entity_type",
        "entity_id",
        "department_id",
        "before",
        "after",
        "request_id",
        "request_method",
        "request_path",
        "actor_label",
        "note",
    )
)
# Proposed: the rehearsal on a copy of the Large data sets the final value.
MAINTENANCE_WORK_MEM = "256MB"
# A partitioned parent holds no storage parameters, and a partition inherits none. The
# insert factor makes vacuum set the visibility map of this append-only table.
PARTITION_STORAGE = (
    "autovacuum_vacuum_scale_factor = 0.02, "
    "autovacuum_analyze_scale_factor = 0.01, "
    "autovacuum_vacuum_insert_scale_factor = 0.02"
)

CREATE_AUDIT_PARTITION = rf"""
CREATE FUNCTION public.create_audit_partition(first_day date) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET "TimeZone" TO 'UTC'
    AS $$
        -- The bounds are UTC only because of the function's TimeZone setting: a timestamptz
        -- renders in the session zone, and a month must start at the same instant in every
        -- caller. ATTACH takes SHARE UPDATE EXCLUSIVE on the parent, so audited writes
        -- continue; `CREATE TABLE ... PARTITION OF` would take ACCESS EXCLUSIVE.
        DECLARE
            month_start timestamptz := pg_catalog.date_trunc('month', first_day::timestamptz);
            month_end timestamptz := month_start + pg_catalog.make_interval(months => 1);
            partition_name text := pg_catalog.format(
                'audit_logs_y%s',
                pg_catalog.to_char(month_start, 'YYYY"m"MM')
            );
        BEGIN
            IF pg_catalog.to_regclass(pg_catalog.format('public.%I', partition_name))
                    IS NOT NULL THEN
                RETURN true;
            END IF;
            -- ATTACH would fail its scan of DEFAULT. Those rows stay readable there.
            IF EXISTS (
                SELECT 1 FROM public.audit_logs_default AS stranded
                WHERE stranded.created_at >= month_start AND stranded.created_at < month_end
            ) THEN
                RETURN false;
            END IF;
            EXECUTE pg_catalog.format(
                'CREATE TABLE public.%I (LIKE public.audit_logs INCLUDING CONSTRAINTS) '
                'WITH ({PARTITION_STORAGE})',
                partition_name
            );
            EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM slateops_app', partition_name);
            EXECUTE pg_catalog.format(
                'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', partition_name
            );
            EXECUTE pg_catalog.format(
                'ALTER TABLE public.audit_logs ATTACH PARTITION public.%I '
                'FOR VALUES FROM (%L) TO (%L)',
                partition_name, month_start, month_end
            );
            RETURN true;
        END;
        $$
"""

# The worker calls this in every API process, so the lock has its own key. A wait shorter
# than deadlock_timeout gives way before the deadlock detector can stop a request.
ENSURE_AUDIT_PARTITIONS = r"""
CREATE FUNCTION public.ensure_audit_partitions() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'pg_temp'
    SET "TimeZone" TO 'UTC'
    SET lock_timeout TO '500ms'
    AS $$
        DECLARE
            this_month date := pg_catalog.date_trunc(
                'month', pg_catalog.transaction_timestamp()
            )::date;
            skipped integer := 0;
        BEGIN
            IF NOT pg_catalog.pg_try_advisory_xact_lock(22328052256015695::bigint) THEN
                RETURN 0;
            END IF;
            FOR step IN 0..2 LOOP
                IF NOT public.create_audit_partition(
                    (this_month + pg_catalog.make_interval(months => step))::date
                ) THEN
                    skipped := skipped + 1;
                END IF;
            END LOOP;
            RETURN skipped;
        END;
        $$
"""

ORGANIZATION_APPENDS = """
CREATE POLICY organization_appends ON public.audit_logs FOR INSERT TO slateops_app WITH
    CHECK (true)
"""
ORGANIZATION_ROWS = """
CREATE POLICY organization_rows ON public.audit_logs FOR SELECT TO slateops_app USING
    (((org_id IS NULL) OR (org_id = ( SELECT
    (NULLIF(current_setting('slateops.org_id'::text, true), ''::text))::uuid AS
    "nullif"))))
"""
FOREIGN_KEYS = (
    "ALTER TABLE public.audit_logs ADD CONSTRAINT fk_audit_logs_org_id_organizations "
    "FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE RESTRICT",
    "ALTER TABLE public.audit_logs ADD CONSTRAINT fk_audit_logs_performed_by_users "
    "FOREIGN KEY (performed_by) REFERENCES public.users(id) ON DELETE SET NULL",
)
PARTITIONED_KEYS = (
    "ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id, created_at)",
    "CREATE INDEX ix_audit_logs_org_created_at_id ON public.audit_logs "
    "(org_id, created_at, id)",
    "CREATE INDEX ix_audit_logs_created_at_id ON public.audit_logs (created_at, id)",
    "CREATE INDEX ix_audit_logs_department_created_at_id ON public.audit_logs "
    "(department_id, created_at, id) WHERE department_id IS NOT NULL",
    "CREATE INDEX ix_audit_logs_entity ON public.audit_logs "
    "(entity_type, entity_id, created_at)",
    "CREATE INDEX ix_audit_logs_actor ON public.audit_logs (performed_by, created_at) "
    "WHERE performed_by IS NOT NULL",
    "CREATE INDEX ix_audit_logs_request ON public.audit_logs (request_id) "
    "WHERE request_id IS NOT NULL",
    "CREATE INDEX ix_audit_logs_action ON public.audit_logs (action)",
)
PLAIN_KEYS = (
    "ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id)",
    "ALTER TABLE public.audit_logs ADD CONSTRAINT uq_audit_logs_org_id_id UNIQUE (org_id, id)",
    "CREATE INDEX ix_audit_logs_created_at_id ON public.audit_logs (created_at, id)",
    "CREATE INDEX ix_audit_logs_department_created_at_id ON public.audit_logs "
    "(department_id, created_at, id)",
    "CREATE INDEX ix_audit_logs_entity ON public.audit_logs "
    "(entity_type, entity_id, created_at)",
    "CREATE INDEX ix_audit_logs_actor ON public.audit_logs (performed_by, created_at)",
    "CREATE INDEX ix_audit_logs_request ON public.audit_logs (request_id)",
    "CREATE INDEX ix_audit_logs_action ON public.audit_logs (action)",
)


def _begin_move() -> None:
    op.execute("LOCK TABLE public.audit_logs IN ACCESS EXCLUSIVE MODE")
    op.execute("""SET LOCAL "TimeZone" = 'UTC'""")
    op.execute(f"SET LOCAL maintenance_work_mem = '{MAINTENANCE_WORK_MEM}'")


def _narrow_parent_grants() -> None:
    # The default privileges of `slateops_owner` just gave the runtime full rights.
    op.execute("REVOKE ALL ON public.audit_logs FROM slateops_app")
    op.execute("GRANT SELECT, INSERT ON public.audit_logs TO slateops_app")


def _copy_by_day(source: str) -> None:
    """Copy `source` into `public.audit_logs`; `id` and `created_at` keep their values."""

    bind = op.get_bind()
    days: list[datetime] = list(
        bind.execute(
            sa.text(
                f"SELECT DISTINCT date_trunc('day', created_at) FROM public.{source} ORDER BY 1"
            )
        ).scalars()
    )
    statement = sa.text(
        f"INSERT INTO public.audit_logs ({COLUMNS}) SELECT {COLUMNS} FROM public.{source} "
        "WHERE created_at >= :day AND created_at < :next_day"
    )
    for day in days:
        started = time.monotonic()
        result = bind.execute(statement, {"day": day, "next_day": day + timedelta(days=1)})
        log.info(
            "Copied %s audit rows of %s in %.3f s",
            result.rowcount,
            day.date().isoformat(),
            time.monotonic() - started,
        )


def _assert_same_rows(source: str) -> None:
    """Compare `source` with `public.audit_logs` by row count and the sum of row hashes."""

    def fingerprint(table: str) -> tuple[object, ...]:
        row = op.get_bind().execute(
            sa.text(
                "SELECT count(*), "
                "coalesce(sum(('x' || substr(md5(t::text), 1, 16))::bit(64)::bigint::numeric), 0) "
                f"FROM {table} AS t"
            )
        ).one()
        return tuple(row)

    if fingerprint(source) != fingerprint("public.audit_logs"):
        raise RuntimeError("The copied audit rows differ from the source rows")


def _finish_move() -> None:
    op.execute("ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY")
    op.execute(ORGANIZATION_APPENDS)
    op.execute(ORGANIZATION_ROWS)
    # Autovacuum never analyzes a partitioned parent.
    op.execute("ANALYZE public.audit_logs")


def upgrade() -> None:
    _begin_move()
    op.execute("ALTER TABLE public.audit_logs RENAME TO audit_logs_unpartitioned")
    op.execute(
        "CREATE TABLE public.audit_logs (LIKE public.audit_logs_unpartitioned "
        "INCLUDING CONSTRAINTS) PARTITION BY RANGE (created_at)"
    )
    _narrow_parent_grants()

    op.execute(
        f"CREATE TABLE public.audit_logs_default (LIKE public.audit_logs INCLUDING CONSTRAINTS) "
        f"WITH ({PARTITION_STORAGE})"
    )
    op.execute("REVOKE ALL ON public.audit_logs_default FROM slateops_app")
    op.execute("ALTER TABLE public.audit_logs_default ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE public.audit_logs ATTACH PARTITION public.audit_logs_default DEFAULT")

    op.execute(CREATE_AUDIT_PARTITION)
    op.execute("ALTER FUNCTION public.create_audit_partition(date) OWNER TO slateops_owner")
    op.execute("REVOKE ALL ON FUNCTION public.create_audit_partition(date) FROM PUBLIC")
    op.execute(ENSURE_AUDIT_PARTITIONS)
    op.execute("ALTER FUNCTION public.ensure_audit_partitions() OWNER TO slateops_owner")
    op.execute("REVOKE ALL ON FUNCTION public.ensure_audit_partitions() FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION public.ensure_audit_partitions() TO slateops_app")
    op.execute(
        """
        SELECT public.create_audit_partition(month::date)
          FROM pg_catalog.generate_series(
              (SELECT date_trunc('month', least(min(created_at), now()))
                 FROM public.audit_logs_unpartitioned),
              date_trunc('month', now()) + interval '2 months',
              interval '1 month'
          ) AS month
        """
    )

    _copy_by_day("audit_logs_unpartitioned")
    _assert_same_rows("public.audit_logs_unpartitioned")
    op.execute("DROP TABLE public.audit_logs_unpartitioned")

    for statement in (*PARTITIONED_KEYS, *FOREIGN_KEYS):
        op.execute(statement)
    _finish_move()


def downgrade() -> None:
    _begin_move()
    op.execute("ALTER TABLE public.audit_logs RENAME TO audit_logs_partitioned")
    op.execute(
        "CREATE TABLE public.audit_logs (LIKE public.audit_logs_partitioned "
        "INCLUDING CONSTRAINTS)"
    )
    _narrow_parent_grants()

    _copy_by_day("audit_logs_partitioned")
    _assert_same_rows("public.audit_logs_partitioned")
    op.execute("DROP TABLE public.audit_logs_partitioned")
    op.execute("DROP FUNCTION public.ensure_audit_partitions()")
    op.execute("DROP FUNCTION public.create_audit_partition(date)")

    for statement in (*PLAIN_KEYS, *FOREIGN_KEYS):
        op.execute(statement)
    _finish_move()
