"""complete board record link audit foreign keys

Revision ID: 7b005128820a
Revises: fd14e81b657c
Create Date: 2026-09-24 10:21:43.655771
"""

from collections.abc import Sequence

from alembic import op

revision: str = "7b005128820a"
down_revision: str | None = "fd14e81b657c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_foreign_key(
        op.f("fk_board_announcement_revision_record_links_performed_by_users"),
        "board_announcement_revision_record_links",
        "users",
        ["performed_by"],
        ["id"],
        ondelete="SET NULL",
        use_alter=True,
    )
    op.create_foreign_key(
        op.f("fk_board_content_record_links_performed_by_users"),
        "board_content_record_links",
        "users",
        ["performed_by"],
        ["id"],
        ondelete="SET NULL",
        use_alter=True,
    )


def downgrade() -> None:
    op.drop_constraint(
        op.f("fk_board_content_record_links_performed_by_users"),
        "board_content_record_links",
        type_="foreignkey",
    )
    op.drop_constraint(
        op.f("fk_board_announcement_revision_record_links_performed_by_users"),
        "board_announcement_revision_record_links",
        type_="foreignkey",
    )
