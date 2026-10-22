"""comms d44 channel scopes

D44 (docs/specs/opencomms-department-access.md): a channel is organization-wide or one
department's. Upgrade drops admissions and channel group access, retires the join_rule and
default_member_ids settings, converts a ``groups`` channel whose ``everyone`` grant allows
posting to an uncategorized ``organization`` channel, soft-deletes every other ``groups`` or
``members`` channel (a read-only or restricted channel is never widened to organization), and
keeps only creator and manager member rows on channels. Direct and group messages are
unchanged.

Downgrade restores the previous schema only, so earlier revisions and the runner's forward
round trips keep working. It does not restore any data the upgrade changed: dropped access
and admission rows, removed lock rows and settings keys, converted or soft-deleted channels
and soft-deleted member rows stay as the upgrade left them.

Revision ID: 168d66144b73
Revises: e03383c56cde
Create Date: 2026-10-22 08:43:25.574985
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.schema import SchemaItem

revision: str = "168d66144b73"
down_revision: str | None = "e03383c56cde"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OWNED = "org_id = nullif(current_setting('openslate.org_id', true), '')::uuid"
RETIRED_KEYS = ("join_rule", "default_member_ids")
SETTING_KEYS = (
    "mode",
    "edit_window_minutes",
    "delete_window_minutes",
    "slow_mode_seconds",
    "formatting",
    "link_previews",
    "allowed_reactions",
    "mention_limit",
    "auto_archive_days",
    "default_thread_subscription",
    "thread_branches",
    "notification_mode",
    "keywords",
    "notify_followed_threads",
    "quiet_hours_start",
    "quiet_hours_end",
    "notification_sound",
    "notification_badges",
    "notification_preview",
    "desktop_notifications",
    "allowed_file_types",
    "max_file_size_mb",
    "file_previews",
    "file_downloads",
    "allowed_record_modules",
    "require_record_link",
    "record_card_fields",
    "locked",
    "restricted_person_ids",
    "restriction_until",
    "allow_export",
    "pinned_record_id",
)
OLD_SETTING_KEYS = (*SETTING_KEYS[:11], *RETIRED_KEYS, *SETTING_KEYS[11:])
CAPABILITY_KEYS = (
    "react",
    "reply",
    "createThread",
    "attachFiles",
    "linkRecords",
    "mentionChannel",
    "pin",
    "manageThreads",
    "deleteOthersMessages",
    "moderate",
    "manageChannel",
    "createChannel",
)
KIND_SHAPE = (
    "(kind = 'channel' AND btrim(name) <> '' AND "
    "(scope IN ('organization','department') OR is_deleted)) OR "
    "(kind IN ('direct','group') AND scope = 'members' AND category_id IS NULL)"
)
OLD_KIND_SHAPE = (
    "(kind = 'channel' AND btrim(name) <> '') OR "
    "(kind IN ('direct','group') AND scope = 'members' AND category_id IS NULL)"
)


def _quoted(keys: Sequence[str]) -> str:
    return ",".join(f"'{key}'" for key in keys)


def _lock_keys(settings: Sequence[str]) -> str:
    return (
        f"(namespace = 'setting' AND key IN ({_quoted(settings)})) "
        f"OR (namespace = 'capability' AND key IN ({_quoted(CAPABILITY_KEYS)}))"
    )


def _replace_check(table: str, name: str, expression: str) -> None:
    op.drop_constraint(name, table, type_="check")
    op.create_check_constraint(name, table, expression)


def upgrade() -> None:
    retired = {"keys": list(RETIRED_KEYS)}
    op.execute(
        sa.text(
            "DELETE FROM public.comms_setting_locks "
            "WHERE namespace = 'setting' AND key = ANY(:keys)"
        ).bindparams(**retired)
    )
    _replace_check("comms_setting_locks", "ck_comms_setting_locks_key", _lock_keys(SETTING_KEYS))
    op.execute(
        sa.text(
            "UPDATE public.comms_settings SET values = values - CAST(:keys AS text[]), "
            "updated_at = now() WHERE values ?| CAST(:keys AS text[])"
        ).bindparams(**retired)
    )
    # A channel where everyone already posts becomes organization-wide; it leaves its
    # category, which may belong to a department (A8).
    op.execute("""
        UPDATE public.comms_conversations AS c
           SET scope = 'organization', category_id = NULL, updated_at = now()
         WHERE c.kind = 'channel' AND c.scope = 'groups' AND NOT c.is_deleted
           AND EXISTS (
               SELECT 1 FROM public.comms_conversation_groups AS g
                WHERE g.org_id = c.org_id AND g.conversation_id = c.id
                  AND g.subject = 'everyone' AND g.level = 'post' AND NOT g.is_deleted)
    """)
    # Never widen a restricted channel: retire it with its stored scope.
    op.execute("""
        UPDATE public.comms_conversations
           SET is_deleted = true, deleted_at = now(), updated_at = now()
         WHERE kind = 'channel' AND scope IN ('groups','members') AND NOT is_deleted
    """)
    op.execute("""
        DELETE FROM public.comms_realtime_grants AS g
         USING public.comms_conversations AS c
         WHERE g.org_id = c.org_id AND g.conversation_id = c.id AND c.is_deleted
    """)
    # On channels a member row now marks only the creator or a manager.
    op.execute("""
        UPDATE public.comms_members AS m
           SET is_deleted = true, deleted_at = now(), updated_at = now()
          FROM public.comms_conversations AS c
         WHERE c.org_id = m.org_id AND c.id = m.conversation_id AND c.kind = 'channel'
           AND NOT m.is_deleted AND m.role <> 'manager' AND m.user_id <> c.created_by
    """)
    _replace_check("comms_conversations", "ck_comms_conversations_kind_shape", KIND_SHAPE)
    op.drop_table("comms_conversation_groups")
    op.drop_table("comms_admissions")


def downgrade() -> None:
    _replace_check("comms_conversations", "ck_comms_conversations_kind_shape", OLD_KIND_SHAPE)
    _replace_check(
        "comms_setting_locks", "ck_comms_setting_locks_key", _lock_keys(OLD_SETTING_KEYS)
    )
    op.create_table(
        "comms_conversation_groups",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=True),
        sa.Column("conversation_id", sa.Uuid(), nullable=True),
        sa.Column("subject", sa.Text(), nullable=False),
        sa.Column("group_id", sa.Uuid(), nullable=True),
        sa.Column("level", sa.Text(), nullable=False),
        *_base_columns(),
        sa.CheckConstraint(
            "(subject = 'everyone' AND group_id IS NULL) OR (subject = 'group' AND group_id IS NOT "
            "NULL)",
            name="ck_comms_conversation_groups_subject",
        ),
        sa.CheckConstraint("level IN ('read','post')", name="ck_comms_conversation_groups_level"),
        sa.CheckConstraint(
            "(category_id IS NOT NULL AND conversation_id IS NULL) OR (category_id IS NULL AND "
            "conversation_id IS NOT NULL)",
            name="ck_comms_conversation_groups_owner",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "category_id"],
            ["comms_categories.org_id", "comms_categories.id"],
            name="fk_comms_conversation_groups_category",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_conversation_groups_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "group_id"],
            ["groups.org_id", "groups.id"],
            name="fk_comms_conversation_groups_group",
            ondelete="RESTRICT",
        ),
        *_owner_keys("comms_conversation_groups"),
    )
    op.create_index(
        "ix_comms_conversation_groups_category",
        "comms_conversation_groups",
        ["org_id", "category_id"],
    )
    op.create_index(
        "ix_comms_conversation_groups_conversation",
        "comms_conversation_groups",
        ["org_id", "conversation_id"],
    )
    op.create_index(
        "ix_comms_conversation_groups_group", "comms_conversation_groups", ["org_id", "group_id"]
    )
    op.create_index(
        "uq_comms_conversation_groups_active",
        "comms_conversation_groups",
        ["org_id", "category_id", "conversation_id", "subject", "group_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_table(
        "comms_admissions",
        sa.Column("org_id", sa.UUID(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'pending'"), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        *_base_columns(),
        sa.CheckConstraint(
            "(status = 'pending') = (resolved_at IS NULL)", name="ck_comms_admissions_resolution"
        ),
        sa.CheckConstraint("kind IN ('request','invitation')", name="ck_comms_admissions_kind"),
        sa.CheckConstraint(
            "status IN ('pending','accepted','declined')", name="ck_comms_admissions_status"
        ),
        sa.ForeignKeyConstraint(
            ["org_id", "conversation_id"],
            ["comms_conversations.org_id", "comms_conversations.id"],
            name="fk_comms_admissions_conversation",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_comms_admissions_user_id_users",
            ondelete="RESTRICT",
        ),
        *_owner_keys("comms_admissions"),
    )
    op.create_index(
        "ix_comms_admissions_conversation",
        "comms_admissions",
        ["org_id", "conversation_id", "created_at", "id"],
    )
    op.create_index("ix_comms_admissions_user", "comms_admissions", ["user_id", "org_id"])
    op.create_index(
        "uq_comms_admissions_pending",
        "comms_admissions",
        ["org_id", "conversation_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending' AND is_deleted = false"),
    )
    for table in ("comms_conversation_groups", "comms_admissions"):
        op.execute(f"ALTER TABLE public.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY organization_rows ON public.{table} TO openslate_app "
            f"USING ({OWNED}) WITH CHECK ({OWNED})"
        )


def _base_columns() -> tuple[SchemaItem, ...]:
    return (
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("is_deleted", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("performed_by", sa.UUID(), nullable=True),
    )


def _owner_keys(table: str) -> tuple[SchemaItem, ...]:
    return (
        sa.ForeignKeyConstraint(
            ["org_id"],
            ["organizations.id"],
            name=f"fk_{table}_org_id_organizations",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=f"fk_{table}_performed_by_users",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=f"{table}_pkey"),
        sa.UniqueConstraint("org_id", "id", name=f"uq_{table}_org_id_id"),
    )
