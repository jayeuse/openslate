"""replace roles and rules with groups and department access

Revision ID: 3515de19214f
Revises: 4b7c722f428c
Create Date: 2026-09-28 10:12:44.018772

Replaces the role table with ``users.role`` (admin, member or guest), renames
``access_groups`` and ``access_group_members`` to ``groups`` and
``group_members`` with every constraint and index, and adds ``group_access``:
one group's read, write or manage level on a department or one of its modules.
The invitation settings move from ``access_policy_defaults`` to
``workspace_profiles``.

Seven content columns referenced roles. Rows with a role audience are converted
to the narrowest audience of their table, so no data reset is needed:

- ``saved_views``: ``private`` (visibility ``private``); ``reports`` and
  ``board_widgets``: ``private``. The owner or creator keeps the item.
- ``board_announcements``, ``board_announcement_revisions`` and
  ``board_events``: ``author``.
- ``board_grants`` rows for a role principal are deleted.

Then the rules layer, the access defaults, service identities, department
memberships and roles are dropped. The downgrade recreates the dropped tables
empty except for their seed rows, restores the role references from
``users.role``, and cannot restore converted audiences or deleted role grants.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "3515de19214f"
down_revision: str | None = "4b7c722f428c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ADMIN_ROLE_ID = "00000000-0000-7000-8000-000000000001"
MEMBER_ROLE_ID = "00000000-0000-7000-8000-000000000002"
ACCESS_DEFAULTS_ID = "00000000-0000-7000-8000-000000000004"
POLICY_VERSION_ID = "00000000-0000-0000-0000-000000000001"

TABLES = (
    ("access_groups", "groups"),
    ("access_group_members", "group_members"),
)

# (table after rename, old constraint, new constraint). Renaming a primary key or
# unique constraint also renames its index.
CONSTRAINTS = (
    ("groups", "access_groups_pkey", "groups_pkey"),
    ("groups", "ck_access_groups_name_not_blank", "ck_groups_name_not_blank"),
    ("groups", "ck_access_groups_revision_positive", "ck_groups_revision_positive"),
    ("groups", "fk_access_groups_performed_by_users", "fk_groups_performed_by_users"),
    ("group_members", "access_group_members_pkey", "group_members_pkey"),
    ("group_members", "uq_access_group_members_group_user", "uq_group_members_group_user"),
    (
        "group_members",
        "fk_access_group_members_group_id_access_groups",
        "fk_group_members_group_id_groups",
    ),
    (
        "group_members",
        "fk_access_group_members_performed_by_users",
        "fk_group_members_performed_by_users",
    ),
    ("group_members", "fk_access_group_members_user_id_users", "fk_group_members_user_id_users"),
)

INDEXES = (
    ("uq_access_groups_name_active_ci", "uq_groups_name_active_ci"),
    ("ix_access_group_members_user_id", "ix_group_members_user_id"),
)

USER_ROLE_CHECK = "role IN ('admin', 'member', 'guest')"
USER_GUEST_CHECK = "(role = 'guest') = (sponsor_user_id IS NOT NULL AND expires_at IS NOT NULL)"
USER_KIND_CHECK = "identity_kind IN ('internal', 'guest')"
USER_KIND_SUBJECT_CHECK = (
    "(identity_kind = 'guest' AND sponsor_user_id IS NOT NULL AND expires_at IS NOT NULL) "
    "OR (identity_kind = 'internal' AND sponsor_user_id IS NULL)"
)

# (table, check name, check without roles, check with roles)
AUDIENCE_CHECKS = (
    (
        "saved_views",
        "ck_saved_views_audience_kind",
        "audience_kind IN ('private', 'everyone', 'user')",
        "audience_kind IN ('private', 'everyone', 'role', 'user')",
    ),
    (
        "saved_views",
        "ck_saved_views_audience_reference",
        "(audience_kind = 'private' AND visibility = 'private' "
        "AND audience_user_id IS NULL) OR "
        "(audience_kind = 'everyone' AND visibility = 'workspace' "
        "AND audience_user_id IS NULL) OR "
        "(audience_kind = 'user' AND visibility = 'workspace' "
        "AND audience_user_id IS NOT NULL)",
        "(audience_kind = 'private' AND visibility = 'private' "
        "AND audience_role_id IS NULL AND audience_user_id IS NULL) OR "
        "(audience_kind = 'everyone' AND visibility = 'workspace' "
        "AND audience_role_id IS NULL AND audience_user_id IS NULL) OR "
        "(audience_kind = 'role' AND visibility = 'workspace' "
        "AND audience_role_id IS NOT NULL AND audience_user_id IS NULL) OR "
        "(audience_kind = 'user' AND visibility = 'workspace' "
        "AND audience_role_id IS NULL AND audience_user_id IS NOT NULL)",
    ),
    (
        "reports",
        "ck_reports_audience",
        "(audience_kind IN ('private', 'everyone') AND audience_user_id IS NULL) OR "
        "(audience_kind = 'user' AND audience_user_id IS NOT NULL)",
        "(audience_kind IN ('private', 'everyone') AND audience_role_id IS NULL "
        "AND audience_user_id IS NULL) OR "
        "(audience_kind = 'role' AND audience_role_id IS NOT NULL "
        "AND audience_user_id IS NULL) OR "
        "(audience_kind = 'user' AND audience_role_id IS NULL "
        "AND audience_user_id IS NOT NULL)",
    ),
    (
        "board_widgets",
        "ck_board_widgets_audience",
        "(audience_kind IN ('private', 'everyone') AND audience_user_id IS NULL) OR "
        "(audience_kind = 'user' AND audience_user_id IS NOT NULL)",
        "(audience_kind IN ('private', 'everyone') AND audience_role_id IS NULL "
        "AND audience_user_id IS NULL) OR "
        "(audience_kind = 'role' AND audience_role_id IS NOT NULL "
        "AND audience_user_id IS NULL) OR "
        "(audience_kind = 'user' AND audience_role_id IS NULL "
        "AND audience_user_id IS NOT NULL)",
    ),
    *(
        (
            table,
            f"ck_{table}_audience",
            "(audience_kind IN ('everyone', 'author') "
            "AND audience_user_id IS NULL AND audience_department_id IS NULL) OR "
            "(audience_kind = 'user' "
            "AND audience_user_id IS NOT NULL AND audience_department_id IS NULL) OR "
            "(audience_kind = 'department' "
            "AND audience_user_id IS NULL AND audience_department_id IS NOT NULL)",
            "(audience_kind IN ('everyone', 'author') AND audience_role_id IS NULL "
            "AND audience_user_id IS NULL AND audience_department_id IS NULL) OR "
            "(audience_kind = 'role' AND audience_role_id IS NOT NULL "
            "AND audience_user_id IS NULL AND audience_department_id IS NULL) OR "
            "(audience_kind = 'user' AND audience_role_id IS NULL "
            "AND audience_user_id IS NOT NULL AND audience_department_id IS NULL) OR "
            "(audience_kind = 'department' AND audience_role_id IS NULL "
            "AND audience_user_id IS NULL AND audience_department_id IS NOT NULL)",
        )
        for table in ("board_events", "board_announcements", "board_announcement_revisions")
    ),
    (
        "board_grants",
        "ck_board_grants_principal_type",
        "principal_type IN ('user', 'everyone')",
        "principal_type IN ('user', 'role', 'everyone')",
    ),
    (
        "board_grants",
        "ck_board_grants_principal_reference",
        "(principal_type = 'user' AND principal_user_id IS NOT NULL) OR "
        "(principal_type = 'everyone' AND principal_user_id IS NULL)",
        "(principal_type = 'user' AND principal_user_id IS NOT NULL "
        "AND principal_role_id IS NULL) OR "
        "(principal_type = 'role' AND principal_user_id IS NULL "
        "AND principal_role_id IS NOT NULL) OR "
        "(principal_type = 'everyone' AND principal_user_id IS NULL "
        "AND principal_role_id IS NULL)",
    ),
)

# (table, role column, plain index on it or None)
ROLE_COLUMNS = (
    ("saved_views", "audience_role_id", None),
    ("reports", "audience_role_id", "ix_reports_audience_role_id"),
    ("board_widgets", "audience_role_id", None),
    ("board_events", "audience_role_id", "ix_board_events_audience_role_id"),
    ("board_announcements", "audience_role_id", "ix_board_announcements_audience_role_id"),
    (
        "board_announcement_revisions",
        "audience_role_id",
        "ix_board_announcement_revisions_audience_role_id",
    ),
    ("board_grants", "principal_role_id", "ix_board_grants_principal_role_id"),
)

# The narrowest audience of each table: only the owner, creator or author sees it.
ROLE_AUDIENCE_CONVERSIONS = (
    (
        "saved_views",
        "UPDATE public.saved_views SET audience_kind = 'private', visibility = 'private', "
        "audience_role_id = NULL WHERE audience_kind = 'role'",
    ),
    (
        "reports",
        "UPDATE public.reports SET audience_kind = 'private', audience_role_id = NULL "
        "WHERE audience_kind = 'role'",
    ),
    (
        "board_widgets",
        "UPDATE public.board_widgets SET audience_kind = 'private', audience_role_id = NULL "
        "WHERE audience_kind = 'role'",
    ),
    (
        "board_events",
        "UPDATE public.board_events SET audience_kind = 'author', audience_role_id = NULL "
        "WHERE audience_kind = 'role'",
    ),
    (
        "board_announcements",
        "UPDATE public.board_announcements SET audience_kind = 'author', "
        "audience_role_id = NULL WHERE audience_kind = 'role'",
    ),
    (
        "board_grants",
        "DELETE FROM public.board_grants WHERE principal_type = 'role'",
    ),
)


def _base_columns() -> list[sa.Column[object]]:
    return [
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
    ]


def _performed_by(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["performed_by"],
        ["users.id"],
        name=op.f(f"fk_{table}_performed_by_users"),
        ondelete="SET NULL",
    )


def _rename_groups(*, forward: bool) -> None:
    def pair(old: str, new: str) -> tuple[str, str]:
        return (old, new) if forward else (new, old)

    for old, new in TABLES if forward else tuple(reversed(TABLES)):
        source, target = pair(old, new)
        op.rename_table(source, target)
    table_names = {new: new if forward else old for old, new in TABLES}
    for table, old, new in CONSTRAINTS:
        source, target = pair(old, new)
        op.execute(
            f"ALTER TABLE public.{table_names[table]} RENAME CONSTRAINT {source} TO {target}"
        )
    for old, new in INDEXES:
        source, target = pair(old, new)
        op.execute(f"ALTER INDEX public.{source} RENAME TO {target}")


def _replace_audience_checks(*, with_roles: bool) -> None:
    for table, name, without_roles_check, with_roles_check in AUDIENCE_CHECKS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(
            name, table, with_roles_check if with_roles else without_roles_check
        )


def _convert_role_audiences() -> None:
    for _table, statement in ROLE_AUDIENCE_CONVERSIONS:
        op.execute(statement)
    # Revisions are immutable for the application; the migration owner converts
    # the retired audience in place with the guard trigger paused.
    op.execute(
        "ALTER TABLE public.board_announcement_revisions "
        "DISABLE TRIGGER trg_board_announcement_revisions_immutable"
    )
    op.execute(
        "UPDATE public.board_announcement_revisions SET audience_kind = 'author', "
        "audience_role_id = NULL WHERE audience_kind = 'role'"
    )
    op.execute(
        "ALTER TABLE public.board_announcement_revisions "
        "ENABLE TRIGGER trg_board_announcement_revisions_immutable"
    )


def _create_group_access() -> None:
    op.create_table(
        "group_access",
        sa.Column("group_id", sa.UUID(), nullable=False),
        sa.Column("department_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.UUID(), nullable=True),
        sa.Column("level", sa.Text(), nullable=False),
        *_base_columns(),
        sa.CheckConstraint("level IN ('read', 'write', 'manage')", name="ck_group_access_level"),
        sa.ForeignKeyConstraint(
            ["department_id"],
            ["departments.id"],
            name=op.f("fk_group_access_department_id_departments"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["groups.id"],
            name=op.f("fk_group_access_group_id_groups"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_group_access_module_id_modules"),
            ondelete="RESTRICT",
        ),
        _performed_by("group_access"),
        sa.PrimaryKeyConstraint("id", name=op.f("group_access_pkey")),
    )
    op.create_index(
        "uq_group_access_target_active",
        "group_access",
        ["group_id", "department_id", "module_id"],
        unique=True,
        postgresql_nulls_not_distinct=True,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index(
        "ix_group_access_department_module_active",
        "group_access",
        ["department_id", "module_id"],
        unique=False,
        postgresql_where=sa.text("is_deleted = false"),
    )
    op.create_index("ix_group_access_module_id", "group_access", ["module_id"], unique=False)


def _add_invitation_settings() -> None:
    op.add_column(
        "workspace_profiles",
        sa.Column(
            "invitation_expiry_days", sa.Integer(), server_default=sa.text("7"), nullable=False
        ),
    )
    op.add_column(
        "workspace_profiles",
        sa.Column(
            "guest_duration_days", sa.Integer(), server_default=sa.text("30"), nullable=False
        ),
    )
    op.execute(
        "UPDATE public.workspace_profiles AS profile "
        "SET invitation_expiry_days = defaults.invitation_expiry_days, "
        "guest_duration_days = defaults.guest_duration_days "
        "FROM public.access_policy_defaults AS defaults "
        "WHERE defaults.singleton_key = 'workspace'"
    )
    op.create_check_constraint(
        "ck_workspace_profiles_invitation_expiry_days_range",
        "workspace_profiles",
        "invitation_expiry_days BETWEEN 1 AND 365",
    )
    op.create_check_constraint(
        "ck_workspace_profiles_guest_duration_days_range",
        "workspace_profiles",
        "guest_duration_days BETWEEN 1 AND 365",
    )


def _add_user_role() -> None:
    op.add_column("users", sa.Column("role", sa.Text(), nullable=True))
    op.execute(
        "UPDATE public.users SET role = CASE "
        "WHEN identity_kind = 'guest' THEN 'guest' "
        "WHEN (SELECT r.role FROM public.roles AS r WHERE r.id = users.role_id) = 'admin' "
        "THEN 'admin' ELSE 'member' END"
    )
    op.alter_column("users", "role", nullable=False)
    op.drop_constraint("ck_users_identity_kind_subject", "users", type_="check")
    op.drop_constraint("ck_users_identity_kind", "users", type_="check")
    op.create_check_constraint("ck_users_role", "users", USER_ROLE_CHECK)
    op.create_check_constraint("ck_users_guest", "users", USER_GUEST_CHECK)


def _drop_role_columns() -> None:
    op.drop_index("ix_saved_views_role_module_active", table_name="saved_views")
    op.drop_index("uq_board_grants_active_role_decision", table_name="board_grants")
    for table, column, index in ROLE_COLUMNS:
        if index is not None:
            op.drop_index(index, table_name=table)
        op.drop_constraint(f"fk_{table}_{column}_roles", table, type_="foreignkey")
        op.drop_column(table, column)
    op.drop_index("ix_users_role_id", table_name="users")
    op.drop_constraint("fk_users_role_id_roles", "users", type_="foreignkey")
    op.drop_column("users", "role_id")
    op.drop_column("users", "identity_kind")


def _drop_retired_tables() -> None:
    for table in (
        "access_default_groups",
        "access_default_departments",
        "access_policy_defaults",
        "service_identities",
        "access_rules",
        "access_policy_versions",
        "user_departments",
        "roles",
    ):
        op.drop_table(table)


def upgrade() -> None:
    _add_user_role()
    _rename_groups(forward=True)
    _create_group_access()
    _add_invitation_settings()
    # The old checks name the role columns; drop them before converting the rows.
    for table, name, _without_roles, _with_roles in AUDIENCE_CHECKS:
        op.drop_constraint(name, table, type_="check")
    _convert_role_audiences()
    _drop_role_columns()
    for table, name, without_roles_check, _with_roles in AUDIENCE_CHECKS:
        op.create_check_constraint(name, table, without_roles_check)
    _drop_retired_tables()


def _recreate_roles() -> None:
    op.create_table(
        "roles",
        sa.Column("role", sa.String(length=100), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "permissions",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        *_base_columns(),
        _performed_by("roles"),
        sa.PrimaryKeyConstraint("id", name=op.f("roles_pkey")),
        sa.UniqueConstraint("role", name="uq_roles_role"),
    )
    op.execute(
        "INSERT INTO public.roles (id, role, permissions) VALUES "
        f"('{ADMIN_ROLE_ID}', 'admin', '{{}}'::jsonb), "
        f"('{MEMBER_ROLE_ID}', 'member', '{{}}'::jsonb)"
    )


def _recreate_user_departments() -> None:
    op.create_table(
        "user_departments",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("department_id", sa.UUID(), nullable=False),
        sa.Column("is_primary", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        *_base_columns(),
        sa.ForeignKeyConstraint(
            ["department_id"],
            ["departments.id"],
            name=op.f("fk_user_departments_department_id_departments"),
            ondelete="RESTRICT",
        ),
        _performed_by("user_departments"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_user_departments_user_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("user_departments_pkey")),
        sa.UniqueConstraint("user_id", "department_id", name="uq_user_departments_user_department"),
    )
    op.create_index(
        "ix_user_departments_department_id", "user_departments", ["department_id"], unique=False
    )
    op.create_index("ix_user_departments_user_id", "user_departments", ["user_id"], unique=False)
    op.create_index(
        "uq_user_departments_primary_user",
        "user_departments",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("is_primary = true"),
    )


def _recreate_policy_tables() -> None:
    op.create_table(
        "access_policy_versions",
        sa.Column(
            "singleton_key",
            sa.String(length=20),
            server_default=sa.text("'workspace'"),
            nullable=False,
        ),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        *_base_columns(),
        sa.CheckConstraint(
            "singleton_key = 'workspace'", name="ck_access_policy_versions_workspace"
        ),
        sa.CheckConstraint("revision > 0", name="ck_access_policy_versions_revision_positive"),
        _performed_by("access_policy_versions"),
        sa.PrimaryKeyConstraint("id", name=op.f("access_policy_versions_pkey")),
        sa.UniqueConstraint("singleton_key", name="uq_access_policy_versions_singleton_key"),
    )
    op.execute(
        "INSERT INTO public.access_policy_versions (id, singleton_key, revision, is_deleted) "
        f"VALUES ('{POLICY_VERSION_ID}', 'workspace', 1, false)"
    )
    op.create_table(
        "access_rules",
        sa.Column("subject_kind", sa.String(length=20), nullable=False),
        sa.Column("subject_id", sa.Uuid(), nullable=True),
        sa.Column("scope_kind", sa.String(length=20), nullable=False),
        sa.Column("scope_id", sa.Uuid(), nullable=True),
        sa.Column("permission_id", sa.String(length=40), nullable=False),
        sa.Column("decision", sa.String(length=10), nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("locked", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("policy_version", sa.Integer(), nullable=False),
        *_base_columns(),
        sa.CheckConstraint(
            "(scope_kind = 'workspace' AND scope_id IS NULL) OR "
            "(scope_kind <> 'workspace' AND scope_id IS NOT NULL)",
            name="ck_access_rules_scope_shape",
        ),
        sa.CheckConstraint(
            "(subject_kind = 'everyone' AND subject_id IS NULL) OR "
            "(subject_kind <> 'everyone' AND subject_id IS NOT NULL)",
            name="ck_access_rules_subject_shape",
        ),
        sa.CheckConstraint(
            "decision IN ('inherit','allow','deny')", name="ck_access_rules_decision"
        ),
        sa.CheckConstraint(
            "permission_id IN ('departments.read','departments.write','modules.read',"
            "'modules.write','fields.read','fields.write','records.read','records.write',"
            "'relationships.read','relationships.write')",
            name="ck_access_rules_permission_id",
        ),
        sa.CheckConstraint(
            "scope_kind IN ('workspace','department','module','field')",
            name="ck_access_rules_scope_kind",
        ),
        sa.CheckConstraint(
            "subject_kind IN ('everyone','role','group','user','service')",
            name="ck_access_rules_subject_kind",
        ),
        sa.CheckConstraint("policy_version > 0", name="ck_access_rules_policy_version_positive"),
        sa.CheckConstraint(
            "starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at",
            name="ck_access_rules_window",
        ),
        _performed_by("access_rules"),
        sa.PrimaryKeyConstraint("id", name=op.f("access_rules_pkey")),
    )
    for name, columns, unique, predicate in (
        (
            "ix_access_rules_permission_scope_active",
            ["permission_id", "scope_kind", "scope_id"],
            False,
            "is_deleted = false",
        ),
        ("ix_access_rules_scope_active", ["scope_kind", "scope_id"], False, "is_deleted = false"),
        (
            "ix_access_rules_subject_active",
            ["subject_kind", "subject_id"],
            False,
            "is_deleted = false",
        ),
        (
            "uq_access_rules_everyone_active",
            ["scope_kind", "scope_id", "permission_id"],
            True,
            "is_deleted = false AND subject_kind = 'everyone'",
        ),
        (
            "uq_access_rules_subject_active",
            ["subject_kind", "subject_id", "scope_kind", "scope_id", "permission_id"],
            True,
            "is_deleted = false AND subject_kind <> 'everyone'",
        ),
    ):
        op.create_index(
            name,
            "access_rules",
            columns,
            unique=unique,
            postgresql_nulls_not_distinct=True if unique else None,
            postgresql_where=sa.text(predicate),
        )


def _recreate_service_identities() -> None:
    op.create_table(
        "service_identities",
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("purpose", sa.Text(), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("role_id", sa.UUID(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "status", sa.String(length=20), server_default=sa.text("'active'"), nullable=False
        ),
        *_base_columns(),
        sa.CheckConstraint("btrim(name) <> ''", name="ck_service_identities_name_not_blank"),
        sa.CheckConstraint("btrim(purpose) <> ''", name="ck_service_identities_purpose_not_blank"),
        sa.CheckConstraint("status IN ('active', 'disabled')", name="ck_service_identities_status"),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name=op.f("fk_service_identities_owner_id_users"),
            ondelete="RESTRICT",
        ),
        _performed_by("service_identities"),
        sa.ForeignKeyConstraint(
            ["role_id"],
            ["roles.id"],
            name=op.f("fk_service_identities_role_id_roles"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("service_identities_pkey")),
    )
    op.create_index(
        "ix_service_identities_owner_id", "service_identities", ["owner_id"], unique=False
    )
    op.create_index(
        "ix_service_identities_role_id", "service_identities", ["role_id"], unique=False
    )
    op.create_index(
        "ix_service_identities_status_expires_at_id",
        "service_identities",
        ["status", "expires_at", "id"],
        unique=False,
    )


def _recreate_access_defaults() -> None:
    op.create_table(
        "access_policy_defaults",
        sa.Column(
            "singleton_key",
            sa.String(length=20),
            server_default=sa.text("'workspace'"),
            nullable=False,
        ),
        sa.Column("default_role_id", sa.UUID(), nullable=False),
        sa.Column(
            "invitation_expiry_days", sa.Integer(), server_default=sa.text("7"), nullable=False
        ),
        sa.Column(
            "guest_duration_days", sa.Integer(), server_default=sa.text("30"), nullable=False
        ),
        sa.Column(
            "service_duration_days", sa.Integer(), server_default=sa.text("90"), nullable=False
        ),
        sa.Column("default_deny", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "require_guest_sponsor", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
        sa.Column(
            "require_service_owner", sa.Boolean(), server_default=sa.text("true"), nullable=False
        ),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        *_base_columns(),
        sa.CheckConstraint(
            "singleton_key = 'workspace'", name="ck_access_policy_defaults_workspace"
        ),
        sa.CheckConstraint(
            "default_deny = true AND require_guest_sponsor = true AND require_service_owner = true",
            name="ck_access_policy_defaults_protected_flags",
        ),
        sa.CheckConstraint(
            "guest_duration_days BETWEEN 1 AND 365",
            name="ck_access_policy_defaults_guest_duration_days_range",
        ),
        sa.CheckConstraint(
            "invitation_expiry_days BETWEEN 1 AND 365",
            name="ck_access_policy_defaults_invitation_expiry_days_range",
        ),
        sa.CheckConstraint("revision > 0", name="ck_access_policy_defaults_revision_positive"),
        sa.CheckConstraint(
            "service_duration_days BETWEEN 1 AND 365",
            name="ck_access_policy_defaults_service_duration_days_range",
        ),
        sa.ForeignKeyConstraint(
            ["default_role_id"],
            ["roles.id"],
            name=op.f("fk_access_policy_defaults_default_role_id_roles"),
            ondelete="RESTRICT",
        ),
        _performed_by("access_policy_defaults"),
        sa.PrimaryKeyConstraint("id", name=op.f("access_policy_defaults_pkey")),
        sa.UniqueConstraint("singleton_key", name="uq_access_policy_defaults_singleton_key"),
    )
    op.create_index(
        "ix_access_policy_defaults_default_role_id",
        "access_policy_defaults",
        ["default_role_id"],
        unique=False,
    )
    op.execute(
        "INSERT INTO public.access_policy_defaults (id, singleton_key, default_role_id, "
        "invitation_expiry_days, guest_duration_days) "
        f"SELECT '{ACCESS_DEFAULTS_ID}', 'workspace', '{MEMBER_ROLE_ID}', "
        "COALESCE(MAX(invitation_expiry_days), 7), COALESCE(MAX(guest_duration_days), 30) "
        "FROM public.workspace_profiles"
    )
    for table, column, target, index in (
        ("access_default_departments", "department_id", "departments", True),
        ("access_default_groups", "group_id", "access_groups", True),
    ):
        op.create_table(
            table,
            sa.Column("policy_defaults_id", sa.UUID(), nullable=False),
            sa.Column(column, sa.UUID(), nullable=False),
            *_base_columns(),
            sa.ForeignKeyConstraint(
                [column],
                [f"{target}.id"],
                name=op.f(f"fk_{table}_{column}_{target}"),
                ondelete="RESTRICT",
            ),
            _performed_by(table),
            sa.ForeignKeyConstraint(
                ["policy_defaults_id"],
                ["access_policy_defaults.id"],
                name=op.f(f"fk_{table}_policy_defaults_id_access_policy_defaults"),
                ondelete="RESTRICT",
            ),
            sa.PrimaryKeyConstraint("id", name=op.f(f"{table}_pkey")),
            sa.UniqueConstraint(
                "policy_defaults_id",
                column,
                name=(
                    "uq_access_default_departments_defaults_department"
                    if table == "access_default_departments"
                    else "uq_access_default_groups_defaults_group"
                ),
            ),
        )
        if index:
            op.create_index(f"ix_{table}_{column}", table, [column], unique=False)


def _restore_role_references() -> None:
    op.add_column("users", sa.Column("role_id", sa.UUID(), nullable=True))
    op.add_column(
        "users",
        sa.Column(
            "identity_kind",
            sa.String(length=20),
            server_default=sa.text("'internal'"),
            nullable=False,
        ),
    )
    op.execute(
        "UPDATE public.users SET "
        f"role_id = CASE WHEN role = 'admin' THEN '{ADMIN_ROLE_ID}'::uuid "
        f"ELSE '{MEMBER_ROLE_ID}'::uuid END, "
        "identity_kind = CASE WHEN role = 'guest' THEN 'guest' ELSE 'internal' END"
    )
    # A member may have kept a sponsor; the old identity check allows none.
    op.execute(
        "UPDATE public.users SET sponsor_user_id = NULL "
        "WHERE role <> 'guest' AND sponsor_user_id IS NOT NULL"
    )
    op.alter_column("users", "role_id", nullable=False)
    op.create_foreign_key(
        "fk_users_role_id_roles", "users", "roles", ["role_id"], ["id"], ondelete="RESTRICT"
    )
    op.create_index("ix_users_role_id", "users", ["role_id"], unique=False)
    op.drop_constraint("ck_users_guest", "users", type_="check")
    op.drop_constraint("ck_users_role", "users", type_="check")
    op.create_check_constraint("ck_users_identity_kind_subject", "users", USER_KIND_SUBJECT_CHECK)
    op.create_check_constraint("ck_users_identity_kind", "users", USER_KIND_CHECK)
    op.drop_column("users", "role")

    for table, column, index in ROLE_COLUMNS:
        op.add_column(table, sa.Column(column, sa.UUID(), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_{column}_roles", table, "roles", [column], ["id"], ondelete="RESTRICT"
        )
        if index is not None:
            op.create_index(index, table, [column], unique=False)
    op.create_index(
        "ix_saved_views_role_module_active",
        "saved_views",
        ["audience_role_id", "module_id"],
        unique=False,
        postgresql_where=sa.text("audience_kind = 'role' AND is_deleted = false"),
    )
    op.create_index(
        "uq_board_grants_active_role_decision",
        "board_grants",
        ["board_id", "principal_role_id", "permission", "effect"],
        unique=True,
        postgresql_where=sa.text("principal_type = 'role' AND is_deleted = false"),
    )


def downgrade() -> None:
    _recreate_roles()
    _restore_role_references()
    _replace_audience_checks(with_roles=True)
    _recreate_user_departments()
    _recreate_policy_tables()
    _recreate_service_identities()
    op.drop_table("group_access")
    _rename_groups(forward=False)
    _recreate_access_defaults()
    op.drop_constraint(
        "ck_workspace_profiles_guest_duration_days_range", "workspace_profiles", type_="check"
    )
    op.drop_constraint(
        "ck_workspace_profiles_invitation_expiry_days_range", "workspace_profiles", type_="check"
    )
    op.drop_column("workspace_profiles", "guest_duration_days")
    op.drop_column("workspace_profiles", "invitation_expiry_days")
