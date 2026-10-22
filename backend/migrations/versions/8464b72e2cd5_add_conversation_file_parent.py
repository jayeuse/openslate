"""add conversation file parent

Revision ID: 8464b72e2cd5
Revises: b8d3c8dd62b7
Create Date: 2026-10-20 00:10:50.071165
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "8464b72e2cd5"
down_revision: str | None = "b8d3c8dd62b7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OLD_PARENT = (
    "(purpose = 'record_attachment' AND record_id IS NOT NULL "
    "AND board_id IS NULL AND department_id IS NULL) OR "
    "(purpose = 'board_attachment' AND board_id IS NOT NULL "
    "AND record_id IS NULL AND department_id IS NULL) OR "
    "(purpose = 'library_document' AND department_id IS NOT NULL "
    "AND record_id IS NULL AND board_id IS NULL) OR "
    "(purpose IN ('workspace_logo','user_avatar') AND record_id IS NULL "
    "AND board_id IS NULL AND department_id IS NULL)"
)
NEW_PARENT = (
    "(purpose = 'record_attachment' AND record_id IS NOT NULL "
    "AND board_id IS NULL AND department_id IS NULL AND conversation_id IS NULL) OR "
    "(purpose = 'board_attachment' AND board_id IS NOT NULL "
    "AND record_id IS NULL AND department_id IS NULL AND conversation_id IS NULL) OR "
    "(purpose = 'library_document' AND department_id IS NOT NULL "
    "AND record_id IS NULL AND board_id IS NULL AND conversation_id IS NULL) OR "
    "(purpose = 'comms_attachment' AND conversation_id IS NOT NULL "
    "AND record_id IS NULL AND board_id IS NULL AND department_id IS NULL) OR "
    "(purpose IN ('workspace_logo','user_avatar') AND record_id IS NULL "
    "AND board_id IS NULL AND department_id IS NULL AND conversation_id IS NULL)"
)


def upgrade() -> None:
    # Generated column/index/FK; Alembic does not discover CHECK expression replacements.
    op.add_column("files", sa.Column("conversation_id", sa.Uuid(), nullable=True))
    op.create_index(op.f("ix_files_conversation_id"), "files", ["conversation_id"], unique=False)
    op.create_foreign_key(
        "fk_files_conversation_id_comms_conversations",
        "files",
        "comms_conversations",
        ["org_id", "conversation_id"],
        ["org_id", "id"],
        ondelete="RESTRICT",
    )
    op.drop_constraint("ck_files_purpose_parent", "files", type_="check")
    op.create_check_constraint("ck_files_purpose_parent", "files", NEW_PARENT)


def downgrade() -> None:
    if op.get_bind().scalar(
        sa.text("SELECT EXISTS (SELECT 1 FROM files WHERE purpose = 'comms_attachment')")
    ):
        raise RuntimeError(
            "Conversation file inventory must be removed by its supported lifecycle "
            "before downgrade"
        )
    op.drop_constraint("ck_files_purpose_parent", "files", type_="check")
    op.create_check_constraint("ck_files_purpose_parent", "files", OLD_PARENT)
    op.drop_constraint("fk_files_conversation_id_comms_conversations", "files", type_="foreignkey")
    op.drop_index(op.f("ix_files_conversation_id"), table_name="files")
    op.drop_column("files", "conversation_id")
