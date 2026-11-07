"""audit seals

`audit_seals` holds one hash for each hour of each audit chain (plan step 2.5, decision D8):
an organization's rows, or the installation's rows when `org_id` is NULL. The key holds the
chain and the hour, with NULLs not distinct, so the installation chain has one seal an hour.

The runtime may read and add seals only. The default privileges of `slateops_owner` give
`slateops_app` every table right, so the revision revokes them before it grants `SELECT,
INSERT`. Row-level security has no UPDATE or DELETE policy, so a returned grant would still
change no row. The INSERT policy binds the organization (K28), unlike `audit_logs`, whose
appends are open, and refuses an hour that starts after the database clock. A CHECK keeps
every seal on a whole UTC hour: the chain hash holds whole seconds. Neither Alembic nor
`alembic check` compares grants or policies: `tests/migrations/test_audit_seal_catalog.py`
owns them.

The foreign key to `organizations` locks that table for a moment. Downgrade drops every seal.
No audit row is lost: a seal is a function of the rows, so the first worker wake after an
upgrade writes the same chain again for unchanged rows.

Revision ID: b1b3908e844b
Revises: 635864bb4a1c
Create Date: 2026-11-07 19:18:19.430377
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b1b3908e844b"
down_revision: str | None = "635864bb4a1c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BOUND = "(SELECT NULLIF(current_setting('slateops.org_id', true), '')::uuid)"
PRIVILEGES = (
    "REVOKE ALL ON public.audit_seals FROM slateops_app",
    "GRANT SELECT, INSERT ON public.audit_seals TO slateops_app",
    "ALTER TABLE public.audit_seals ENABLE ROW LEVEL SECURITY",
    "CREATE POLICY organization_rows ON public.audit_seals FOR SELECT TO slateops_app "
    f"USING (org_id IS NULL OR org_id = {BOUND})",
    "CREATE POLICY organization_appends ON public.audit_seals FOR INSERT TO slateops_app "
    f"WITH CHECK ((org_id IS NULL OR org_id = {BOUND}) AND hour_start <= pg_catalog.now())",
)


def upgrade() -> None:
    op.create_table(
        "audit_seals",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("org_id", sa.UUID(), nullable=True),
        sa.Column("hour_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("row_count", sa.BigInteger(), nullable=False),
        sa.Column("rows_hash", sa.LargeBinary(), nullable=False),
        sa.Column("chain_hash", sa.LargeBinary(), nullable=False),
        sa.Column("form", sa.SmallInteger(), nullable=False),
        sa.Column("sealed_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("octet_length(chain_hash) = 32", name="ck_audit_seals_chain_hash"),
        sa.CheckConstraint("octet_length(rows_hash) = 32", name="ck_audit_seals_rows_hash"),
        sa.CheckConstraint("row_count >= 0", name="ck_audit_seals_row_count"),
        sa.CheckConstraint(
            "(extract(epoch FROM hour_start) % 3600) = 0", name="ck_audit_seals_whole_hour"
        ),
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=op.f("fk_audit_seals_org_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("audit_seals_pkey")),
        sa.UniqueConstraint(
            "org_id",
            "hour_start",
            name="uq_audit_seals_org_hour",
            postgresql_nulls_not_distinct=True,
        ),
    )
    for statement in PRIVILEGES:
        op.execute(statement)


def downgrade() -> None:
    op.drop_table("audit_seals")
