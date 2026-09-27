"""add announcement publish work kind

Revision ID: 56e5accc6972
Revises: e84debb45901
Create Date: 2026-09-23 23:33:09.913535
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "56e5accc6972"
down_revision: str | None = "e84debb45901"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _replace_work_checks(*, announcement_enabled: bool) -> None:
    op.drop_constraint("ck_scheduled_work_kind", "scheduled_work", type_="check")
    op.drop_constraint("ck_scheduled_work_run", "scheduled_work", type_="check")
    if announcement_enabled:
        op.create_check_constraint(
            "ck_scheduled_work_kind",
            "scheduled_work",
            "kind IN ('report-run', 'announcement-publish')",
        )
        op.create_check_constraint(
            "ck_scheduled_work_source",
            "scheduled_work",
            "(kind = 'report-run' AND report_id IS NOT NULL AND announcement_id IS NULL "
            "AND source_revision IS NULL AND scheduling_actor_id IS NULL "
            "AND publication_result_id IS NULL) OR "
            "(kind = 'announcement-publish' AND report_id IS NULL "
            "AND announcement_id IS NOT NULL AND source_revision IS NOT NULL "
            "AND source_revision > 0 AND scheduling_actor_id IS NOT NULL AND run_id IS NULL)",
        )
        op.create_check_constraint(
            "ck_scheduled_work_run",
            "scheduled_work",
            "(kind = 'report-run' AND ((state = 'succeeded' AND run_id IS NOT NULL) "
            "OR (state <> 'succeeded' AND run_id IS NULL))) OR "
            "(kind = 'announcement-publish' AND "
            "((state = 'succeeded' AND publication_result_id IS NOT NULL) "
            "OR (state <> 'succeeded' AND publication_result_id IS NULL)))",
        )
    else:
        op.create_check_constraint(
            "ck_scheduled_work_kind", "scheduled_work", "kind = 'report-run'"
        )
        op.create_check_constraint(
            "ck_scheduled_work_run",
            "scheduled_work",
            "(state = 'succeeded' AND run_id IS NOT NULL) "
            "OR (state <> 'succeeded' AND run_id IS NULL)",
        )


def upgrade() -> None:
    op.add_column("scheduled_work", sa.Column("announcement_id", sa.UUID(), nullable=True))
    op.add_column("scheduled_work", sa.Column("source_revision", sa.Integer(), nullable=True))
    op.add_column("scheduled_work", sa.Column("scheduling_actor_id", sa.UUID(), nullable=True))
    op.add_column("scheduled_work", sa.Column("publication_result_id", sa.UUID(), nullable=True))
    # Existing rows already have report-run kind; this preserves the same
    # identity for any legacy rows while making future SQL inserts explicit.
    op.execute("UPDATE scheduled_work SET kind = 'report-run' WHERE kind IS NULL")
    op.alter_column(
        "scheduled_work", "kind", existing_type=sa.String(length=24), server_default="report-run"
    )
    op.alter_column("scheduled_work", "report_id", existing_type=sa.UUID(), nullable=True)
    _replace_work_checks(announcement_enabled=True)
    op.drop_index("ix_scheduled_work_due", table_name="scheduled_work")
    op.create_index(
        "ix_scheduled_work_due",
        "scheduled_work",
        ["kind", "state", "next_attempt_at", "id"],
        unique=False,
    )
    op.drop_index("ix_scheduled_work_expired", table_name="scheduled_work")
    op.create_index(
        "ix_scheduled_work_expired",
        "scheduled_work",
        ["kind", "state", "lease_expires_at", "id"],
        unique=False,
    )
    op.create_index(
        "ix_scheduled_work_publication_result_id",
        "scheduled_work",
        ["publication_result_id"],
        unique=False,
    )
    op.create_index(
        "ix_scheduled_work_scheduling_actor_id",
        "scheduled_work",
        ["scheduling_actor_id"],
        unique=False,
    )
    op.create_unique_constraint(
        "uq_scheduled_work_announcement_occurrence",
        "scheduled_work",
        ["announcement_id", "source_revision"],
    )
    op.create_foreign_key(
        op.f("fk_scheduled_work_announcement_id_board_announcements"),
        "scheduled_work",
        "board_announcements",
        ["announcement_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        op.f("fk_scheduled_work_publication_result_id_board_announcement_revisions"),
        "scheduled_work",
        "board_announcement_revisions",
        ["publication_result_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_foreign_key(
        op.f("fk_scheduled_work_scheduling_actor_id_users"),
        "scheduled_work",
        "users",
        ["scheduling_actor_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def downgrade() -> None:
    bind = op.get_bind()
    remaining_board_work = bind.scalar(
        sa.text("SELECT EXISTS (SELECT 1 FROM scheduled_work WHERE kind <> 'report-run')")
    )
    if remaining_board_work:
        raise RuntimeError("Cannot downgrade while announcement publication work is retained")
    op.drop_constraint("ck_scheduled_work_source", "scheduled_work", type_="check")
    _replace_work_checks(announcement_enabled=False)
    op.drop_constraint(
        op.f("fk_scheduled_work_scheduling_actor_id_users"),
        "scheduled_work",
        type_="foreignkey",
    )
    op.drop_constraint(
        op.f("fk_scheduled_work_publication_result_id_board_announcement_revisions"),
        "scheduled_work",
        type_="foreignkey",
    )
    op.drop_constraint(
        op.f("fk_scheduled_work_announcement_id_board_announcements"),
        "scheduled_work",
        type_="foreignkey",
    )
    op.drop_constraint(
        "uq_scheduled_work_announcement_occurrence", "scheduled_work", type_="unique"
    )
    op.drop_index("ix_scheduled_work_scheduling_actor_id", table_name="scheduled_work")
    op.drop_index("ix_scheduled_work_publication_result_id", table_name="scheduled_work")
    op.drop_index("ix_scheduled_work_expired", table_name="scheduled_work")
    op.create_index(
        "ix_scheduled_work_expired",
        "scheduled_work",
        ["state", "lease_expires_at", "id"],
        unique=False,
    )
    op.drop_index("ix_scheduled_work_due", table_name="scheduled_work")
    op.create_index(
        "ix_scheduled_work_due",
        "scheduled_work",
        ["state", "next_attempt_at", "id"],
        unique=False,
    )
    op.alter_column("scheduled_work", "report_id", existing_type=sa.UUID(), nullable=False)
    op.alter_column(
        "scheduled_work", "kind", existing_type=sa.String(length=24), server_default=None
    )
    op.drop_column("scheduled_work", "publication_result_id")
    op.drop_column("scheduled_work", "scheduling_actor_id")
    op.drop_column("scheduled_work", "source_revision")
    op.drop_column("scheduled_work", "announcement_id")
