"""freeze board file content owner

Revision ID: 69b09ccee10b
Revises: cb5ca3aef02b
Create Date: 2026-09-24 09:51:52.099710
"""
from collections.abc import Sequence

from alembic import op

revision: str = "69b09ccee10b"
down_revision: str | None = "cb5ca3aef02b"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Alembic cannot autogenerate a trigger from a mapped ownership contract.
    op.execute("""
        CREATE FUNCTION reject_board_content_owner_change()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF OLD.board_id IS DISTINCT FROM NEW.board_id
                OR OLD.file_id IS DISTINCT FROM NEW.file_id
                OR OLD.event_id IS DISTINCT FROM NEW.event_id
                OR OLD.announcement_id IS DISTINCT FROM NEW.announcement_id THEN
                RAISE EXCEPTION 'board file content owner is immutable'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN NEW;
        END;
        $$
    """)
    op.execute("""
        CREATE TRIGGER trg_board_content_attachment_immutable
        BEFORE UPDATE ON board_content_attachments
        FOR EACH ROW EXECUTE FUNCTION reject_board_content_owner_change()
    """)


def downgrade() -> None:
    op.execute(
        "DROP TRIGGER trg_board_content_attachment_immutable ON board_content_attachments"
    )
    op.execute("DROP FUNCTION reject_board_content_owner_change()")
