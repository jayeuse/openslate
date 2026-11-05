"""partial index is false

PostgreSQL matches a query term against a partial index predicate by form. The ORM renders
`.is_(False)` as `IS false`, and that term matches neither `is_deleted = false` nor
`NOT is_deleted`, so these 28 indexes could not serve those queries (plan finding F26). The
same holds for `.is_(True)` and a bare `is_home` or `is_default`.

Each index is rebuilt under a temporary name, and the new index is valid before the old one
is dropped, so a unique rule always has an index. Alembic writes the version row only after
this function returns, so a stopped run repeats it. Each step reads the catalog and resumes
from the state that a stop leaves:

- An INVALID `<name>_swap` is a build that stopped; drop it and build it again.
- A VALID `<name>_swap` can be the only index that enforces a unique rule; keep it.
- `<name>` with the target predicate is finished.

The catalog reads make offline `--sql` mode unusable for this revision. Alembic does not
compare `postgresql_where`, so `alembic check` is no evidence for these predicates;
`tests/migrations/test_partial_index_predicates.py` is.

Revision ID: 65bf3d1eb512
Revises: f8852c638a76
Create Date: 2026-11-05 22:40:09.311121
"""

from collections.abc import Sequence
from typing import NamedTuple

import sqlalchemy as sa
from alembic import op

revision: str = "65bf3d1eb512"
down_revision: str | None = "f8852c638a76"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Predicates are in the text of pg_get_expr, so a catalog read compares them exactly.
EQUALS_FALSE = "(is_deleted = false)"
IS_FALSE = "(is_deleted IS FALSE)"


class PartialIndex(NamedTuple):
    name: str
    table: str
    columns: tuple[str | sa.TextClause, ...]
    old_where: str
    new_where: str
    unique: bool = True
    nulls_not_distinct: bool | None = None


INDEXES: tuple[PartialIndex, ...] = (
    PartialIndex(
        "ix_comms_messages_live_roots", "comms_messages",
        ("org_id", "conversation_id", "seq"),
        "((parent_id IS NULL) AND (is_deleted = false))",
        "((parent_id IS NULL) AND (is_deleted IS FALSE))",
        unique=False,
    ),
    PartialIndex(
        "ix_group_access_department_module_active", "group_access",
        ("department_id", "module_id"),
        EQUALS_FALSE, IS_FALSE, unique=False,
    ),
    PartialIndex(
        "ix_in_app_notifications_recipient_unread", "in_app_notifications",
        ("recipient_id", "created_at", "id"),
        "((read_at IS NULL) AND (is_deleted = false))",
        "((read_at IS NULL) AND (is_deleted IS FALSE))",
        unique=False,
    ),
    PartialIndex(
        "ix_relationship_edges_active_target", "relationship_edges",
        ("field_id", "target_record_id"),
        EQUALS_FALSE, IS_FALSE, unique=False,
    ),
    PartialIndex(
        "uq_board_groups_board_group_active", "board_groups",
        ("board_id", "group_id"),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_comms_capability_grants_active", "comms_capability_grants",
        ("org_id", "scope", "category_id", "conversation_id", "capability", "subject", "group_id"),
        EQUALS_FALSE, IS_FALSE, nulls_not_distinct=True,
    ),
    PartialIndex(
        "uq_comms_channel_access_active", "comms_channel_access",
        ("org_id", "conversation_id", "category_id", "subject", "group_id", "user_id"),
        EQUALS_FALSE, IS_FALSE, nulls_not_distinct=True,
    ),
    PartialIndex(
        "uq_comms_members_active", "comms_members",
        ("org_id", "conversation_id", "user_id"),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_comms_setting_locks_active", "comms_setting_locks",
        ("org_id", "namespace", "key"),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_comms_settings_active", "comms_settings",
        ("org_id", "scope", "category_id", "conversation_id"),
        EQUALS_FALSE, IS_FALSE, nulls_not_distinct=True,
    ),
    PartialIndex(
        "uq_dashboard_widgets_active_position", "dashboard_widgets",
        ("dashboard_id", "position"),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_departments_name_active", "departments",
        ("org_id", "department_name"),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_fields_module_name_active", "fields",
        ("module_id", "name"),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_fields_module_position_active", "fields",
        ("module_id", "position"),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_group_access_target_active", "group_access",
        ("group_id", "department_id", "module_id"),
        EQUALS_FALSE, IS_FALSE, nulls_not_distinct=True,
    ),
    PartialIndex(
        "uq_groups_name_active_ci", "groups",
        ("org_id", sa.text("lower((name)::text)")),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_memberships_user_pending", "memberships",
        ("user_id",),
        "(((status)::text = 'pending'::text) AND (is_deleted = false))",
        "(((status)::text = 'pending'::text) AND (is_deleted IS FALSE))",
    ),
    PartialIndex(
        "uq_modules_department_name_active", "modules",
        ("department_id", "module_name"),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_record_trigger_actions_position_active", "record_trigger_actions",
        ("trigger_id", "position"),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_record_trigger_conditions_position_active", "record_trigger_conditions",
        ("trigger_id", "position"),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_relationship_edges_active", "relationship_edges",
        ("field_id", "source_record_id", "target_record_id"),
        EQUALS_FALSE, IS_FALSE,
    ),
    PartialIndex(
        "uq_board_cards_board_record_active", "board_cards",
        ("board_id", "record_id"),
        "((record_id IS NOT NULL) AND (archived_at IS NULL) AND (NOT is_deleted))",
        "((record_id IS NOT NULL) AND (archived_at IS NULL) AND (is_deleted IS FALSE))",
    ),
    PartialIndex(
        "uq_board_cards_stage_rank_active", "board_cards",
        ("stage_id", "rank"),
        "((archived_at IS NULL) AND (NOT is_deleted))",
        "((archived_at IS NULL) AND (is_deleted IS FALSE))",
    ),
    PartialIndex(
        "uq_board_stages_board_position_active", "board_stages",
        ("board_id", "position"),
        "((archived_at IS NULL) AND (NOT is_deleted))",
        "((archived_at IS NULL) AND (is_deleted IS FALSE))",
    ),
    PartialIndex(
        "uq_boards_company", "boards",
        ("org_id", "scope"),
        "(((scope)::text = 'company'::text) AND (NOT is_deleted))",
        "(((scope)::text = 'company'::text) AND (is_deleted IS FALSE))",
    ),
    PartialIndex(
        "uq_boards_department", "boards",
        ("department_id",),
        "(((scope)::text = 'department'::text) AND (NOT is_deleted))",
        "(((scope)::text = 'department'::text) AND (is_deleted IS FALSE))",
    ),
    PartialIndex(
        "uq_dashboards_department_home", "dashboards",
        ("org_id", "department_id"),
        "(is_home AND (NOT is_deleted))", "((is_home IS TRUE) AND (is_deleted IS FALSE))",
    ),
    PartialIndex(
        "uq_saved_views_module_default", "saved_views",
        ("module_id",),
        "(is_default AND (NOT is_deleted))", "((is_default IS TRUE) AND (is_deleted IS FALSE))",
    ),
)

_INDEX_STATE = sa.text(
    "SELECT pg_get_expr(indpred, indrelid) AS predicate, indisvalid AS valid "
    "FROM pg_index WHERE indexrelid = to_regclass(:name)"
)


def _state(name: str) -> sa.Row | None:
    return op.get_bind().execute(_INDEX_STATE, {"name": f"public.{name}"}).first()


def _swap(index: PartialIndex, where: str) -> None:
    current = _state(index.name)
    if current is not None and current.predicate == where:
        return
    swap_name = f"{index.name}_swap"
    swap = _state(swap_name)
    if swap is None or not swap.valid:
        op.drop_index(
            swap_name, table_name=index.table, postgresql_concurrently=True, if_exists=True
        )
        op.create_index(
            swap_name,
            index.table,
            list(index.columns),
            unique=index.unique,
            postgresql_where=sa.text(where),
            postgresql_nulls_not_distinct=index.nulls_not_distinct,
            postgresql_concurrently=True,
        )
    op.drop_index(index.name, table_name=index.table, postgresql_concurrently=True, if_exists=True)
    op.execute(f"ALTER INDEX public.{swap_name} RENAME TO {index.name}")


def upgrade() -> None:
    with op.get_context().autocommit_block():
        for index in INDEXES:
            _swap(index, index.new_where)


def downgrade() -> None:
    with op.get_context().autocommit_block():
        for index in INDEXES:
            _swap(index, index.old_where)
