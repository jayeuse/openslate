"""update board revision link guard for live titles

Revision ID: a58a6c1f2e72
Revises: 6ef0fc66ebe2
Create Date: 2026-09-28 15:44:34.753787
"""

from collections.abc import Sequence

from alembic import op

revision: str = "a58a6c1f2e72"
down_revision: str | None = "6ef0fc66ebe2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Autogenerate found no ORM changes. Replace the existing function body in
    # place so its trigger, owner and EXECUTE grants remain intact.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION public.board_revision_record_link_guard()
        RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE source_module uuid; current_link uuid;
        BEGIN
            IF TG_OP = 'UPDATE' THEN
                RAISE EXCEPTION 'Published Board Record links are immutable'
                    USING ERRCODE = '23514';
            END IF;
            SELECT module_id INTO source_module FROM public.records WHERE id = NEW.record_id;
            SELECT link.id INTO current_link
              FROM public.board_record_links AS link
              JOIN public.board_post_revisions AS revision
                ON revision.post_id = link.post_id
             WHERE revision.id = NEW.revision_id
               AND link.record_id = NEW.record_id
               AND link.module_id = NEW.module_id;
            IF source_module IS DISTINCT FROM NEW.module_id OR current_link IS NULL THEN
                RAISE EXCEPTION 'Published Board Record link parent mismatch'
                    USING ERRCODE = '23514';
            END IF;
            RETURN NEW;
        END;
        $$
        """
    )


def downgrade() -> None:
    raise RuntimeError(
        "Board revision link guard cannot use the removed label columns in field model v4"
    )
