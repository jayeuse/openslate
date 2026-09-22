"""repair automation schedule progress schema

Revision ID: 5147066a0b3a
Revises: ff192a8fcc06
Create Date: 2026-09-22 00:03:15.262203
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "5147066a0b3a"
down_revision: str | None = "ff192a8fcc06"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # The predecessor revision existed in two development-time shapes: databases
    # already stamped at it may lack these columns, while fresh databases include
    # them. Conditional DDL converges both states at this new revision.
    op.execute(
        sa.text(
            """
            ALTER TABLE public.published_automation_events
                ADD COLUMN IF NOT EXISTS schedule_upper_record_id uuid,
                ADD COLUMN IF NOT EXISTS schedule_cursor_record_id uuid,
                ADD COLUMN IF NOT EXISTS schedule_matched_count integer DEFAULT 0 NOT NULL,
                ADD COLUMN IF NOT EXISTS schedule_action_count integer DEFAULT 0 NOT NULL
            """
        )
    )
    op.execute(
        sa.text(
            """
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM pg_constraint
                    WHERE conname = 'ck_published_automation_events_schedule_progress'
                      AND conrelid = 'public.published_automation_events'::regclass
                ) THEN
                    ALTER TABLE public.published_automation_events
                        ADD CONSTRAINT ck_published_automation_events_schedule_progress
                        CHECK (
                            event_kind = 'schedule'
                            OR (
                                schedule_upper_record_id IS NULL
                                AND schedule_cursor_record_id IS NULL
                                AND schedule_matched_count = 0
                                AND schedule_action_count = 0
                            )
                        );
                END IF;
            END
            $$
            """
        )
    )


def downgrade() -> None:
    # The predecessor revision owns this schema on fresh databases. Keep it
    # intact when stepping back from this repair revision.
    pass
