"""self profile and avatars

Revision ID: d3703f345c2f
Revises: c64062dacada
Create Date: 2026-10-10 01:30:12.831572
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d3703f345c2f"
down_revision: str | None = "c64062dacada"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LEGACY_APPEARANCE = (
    "CASE WHEN jsonb_typeof(appearance) = 'object' THEN "
    "(appearance ?& ARRAY['motion','keyboard_shortcuts'] AND "
    "appearance - ARRAY['motion','keyboard_shortcuts'] = '{}'::jsonb AND "
    "appearance ->> 'motion' IN ('system','reduce') AND "
    "jsonb_typeof(appearance -> 'keyboard_shortcuts') = 'boolean') IS TRUE ELSE false END"
)
PROFILE_APPEARANCE = (
    "CASE WHEN jsonb_typeof(appearance) = 'object' THEN "
    "(appearance ?& ARRAY['motion','keyboard_shortcuts'] AND "
    "appearance - ARRAY['motion','keyboard_shortcuts','timezone','date_format',"
    "'time_format','week_start','start_page'] = '{}'::jsonb AND "
    "appearance ->> 'motion' IN ('system','reduce') AND "
    "jsonb_typeof(appearance -> 'keyboard_shortcuts') = 'boolean' AND "
    "(NOT (appearance ? 'timezone') OR jsonb_typeof(appearance -> 'timezone') "
    "IN ('string','null')) AND "
    "(NOT (appearance ? 'date_format') OR appearance ->> 'date_format' "
    "IN ('organization','dmy','mdy','ymd')) AND "
    "(NOT (appearance ? 'time_format') OR appearance ->> 'time_format' "
    "IN ('organization','12h','24h')) AND "
    "(NOT (appearance ? 'week_start') OR appearance ->> 'week_start' "
    "IN ('organization','monday','sunday')) AND "
    "(NOT (appearance ? 'start_page') OR appearance ->> 'start_page' "
    "IN ('automatic','sandbox','boards','comms','access','openview','manage','platform'))) "
    "IS TRUE ELSE false END"
)
FILE_PARENTS = (
    "(purpose = 'record_attachment' AND record_id IS NOT NULL "
    "AND board_id IS NULL AND department_id IS NULL) OR "
    "(purpose = 'board_attachment' AND board_id IS NOT NULL "
    "AND record_id IS NULL AND department_id IS NULL) OR "
    "(purpose = 'library_document' AND department_id IS NOT NULL "
    "AND record_id IS NULL AND board_id IS NULL) OR "
    "(purpose = 'workspace_logo' AND record_id IS NULL "
    "AND board_id IS NULL AND department_id IS NULL)"
)
LOGO_DELETION = (
    "deletion_origin IS NULL OR (deletion_origin = 'logo_replacement' "
    "AND purpose = 'workspace_logo' AND is_deleted = true "
    "AND state = 'deleting' AND operation_id IS NOT NULL)"
)
AVATAR_DELETION = (
    "deletion_origin IS NULL OR (((deletion_origin = 'logo_replacement' "
    "AND purpose = 'workspace_logo') OR (deletion_origin = 'avatar_replacement' "
    "AND purpose = 'user_avatar')) AND is_deleted = true "
    "AND state = 'deleting' AND operation_id IS NOT NULL)"
)


def upgrade() -> None:
    op.add_column("users", sa.Column("phone", sa.String(length=32), nullable=True))
    op.add_column("users", sa.Column("bio", sa.String(length=280), nullable=True))
    op.add_column("users", sa.Column("avatar_file_id", sa.UUID(), nullable=True))
    op.create_index(op.f("ix_users_avatar_file_id"), "users", ["avatar_file_id"], unique=False)
    op.create_foreign_key(
        "fk_users_avatar_file_id_files",
        "users",
        "files",
        ["avatar_file_id"],
        ["id"],
        ondelete="SET NULL",
        use_alter=True,
    )
    # Autogenerate does not detect changed CHECKs; explicitly match model invariants.
    op.drop_constraint("ck_users_appearance", "users", type_="check")
    op.create_check_constraint("ck_users_appearance", "users", PROFILE_APPEARANCE)
    op.drop_constraint("ck_files_purpose_parent", "files", type_="check")
    op.create_check_constraint(
        "ck_files_purpose_parent",
        "files",
        FILE_PARENTS.replace(
            "purpose = 'workspace_logo'", "purpose IN ('workspace_logo','user_avatar')"
        ),
    )
    op.create_check_constraint(
        "ck_files_avatar_size",
        "files",
        "purpose != 'user_avatar' OR (expected_size <= 2097152 AND "
        "(actual_size IS NULL OR actual_size <= 2097152))",
    )
    op.drop_constraint("ck_files_deletion_origin", "files", type_="check")
    op.create_check_constraint("ck_files_deletion_origin", "files", AVATAR_DELETION)


def downgrade() -> None:
    if op.get_bind().scalar(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM users WHERE phone IS NOT NULL OR bio IS NOT NULL "
            "OR avatar_file_id IS NOT NULL OR appearance ?| "
            "ARRAY['timezone','date_format','time_format','week_start','start_page']) "
            "OR EXISTS (SELECT 1 FROM files WHERE purpose='user_avatar')"
        )
    ):
        raise RuntimeError("Cannot downgrade while profile, regional preferences or avatars exist")
    op.drop_constraint("ck_files_deletion_origin", "files", type_="check")
    op.create_check_constraint("ck_files_deletion_origin", "files", LOGO_DELETION)
    op.drop_constraint("ck_files_avatar_size", "files", type_="check")
    op.drop_constraint("ck_files_purpose_parent", "files", type_="check")
    op.create_check_constraint("ck_files_purpose_parent", "files", FILE_PARENTS)
    op.drop_constraint("ck_users_appearance", "users", type_="check")
    op.create_check_constraint("ck_users_appearance", "users", LEGACY_APPEARANCE)
    op.drop_constraint("fk_users_avatar_file_id_files", "users", type_="foreignkey")
    op.drop_index(op.f("ix_users_avatar_file_id"), table_name="users")
    op.drop_column("users", "avatar_file_id")
    op.drop_column("users", "bio")
    op.drop_column("users", "phone")
