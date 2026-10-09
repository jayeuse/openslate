"""Add saved charts and widget query references

Revision ID: c64062dacada
Revises: 5d4e4a094aa7
Create Date: 2026-10-09 08:08:03.435555
"""

from collections.abc import Sequence
from typing import Annotated, Literal, Self
from uuid import UUID

import sqlalchemy as sa
from alembic import op
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    ValidationError,
    field_validator,
    model_validator,
)
from sqlalchemy.dialects import postgresql
from sqlalchemy.engine import Connection

revision: str = "c64062dacada"
down_revision: str | None = "5d4e4a094aa7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Freeze the predecessor's grammar here: later application schemas accept a
# different config union, so importing them would change this revision's meaning.
PreMigrationBoardFieldType = Literal[
    "text",
    "long_text",
    "email",
    "url",
    "number",
    "decimal",
    "int",
    "boolean",
    "date",
    "datetime",
    "select",
    "user",
]
LegacyScalar = Annotated[str, Field(max_length=4000)] | StrictBool | StrictInt | StrictFloat


class _LegacyFieldReference(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field_id: UUID
    expected_type: PreMigrationBoardFieldType


class _LegacyQueryFilter(_LegacyFieldReference):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    operator: Literal[
        "eq",
        "neq",
        "lt",
        "lte",
        "gt",
        "gte",
        "contains",
        "prefix",
        "suffix",
        "in",
        "empty",
        "not_empty",
        "blank",
        "not_blank",
    ]
    value: (
        LegacyScalar | Annotated[list[LegacyScalar], Field(min_length=1, max_length=100)] | None
    ) = None

    @model_validator(mode="after")
    def valid_predicate(self) -> Self:
        empty_checks = {"empty", "not_empty", "blank", "not_blank"}
        if self.operator in empty_checks:
            if self.value is not None:
                raise ValueError("Empty checks do not accept a value")
        elif self.value is None:
            raise ValueError("Comparison requires a value")
        elif (self.operator == "in") != isinstance(self.value, list):
            raise ValueError("Only membership accepts a list")
        allowed = {"eq", "neq", *empty_checks}
        if self.expected_type in {"text", "long_text", "email", "url"}:
            allowed |= {"contains", "prefix", "suffix"}
        elif self.expected_type == "select":
            allowed |= {"contains", "in"}
        elif self.expected_type in {"number", "decimal", "int", "date", "datetime"}:
            allowed |= {"lt", "lte", "gt", "gte"}
        if self.operator not in allowed:
            raise ValueError("Operator is unsupported for this field type")
        return self


class _LegacyBoardConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    version: Literal[1] = 1
    fields: list[_LegacyFieldReference] = Field(default_factory=list, max_length=24)
    filters: list[_LegacyQueryFilter] = Field(default_factory=list, max_length=8)
    logic: Literal["and", "or"] = "and"
    metric: _LegacyFieldReference | None = None
    visualization: Literal["bar", "line", "pie"] = "bar"
    size: Literal["half", "full"] = "half"
    refresh: Literal["manual", "one-minute", "five-minutes"] = "manual"
    pinned: StrictBool = False

    @field_validator("version", mode="before")
    @classmethod
    def integer_version(cls, value: object) -> object:
        if type(value) is not int or value != 1:
            raise ValueError("Legacy config version must be integer one")
        return value

    @model_validator(mode="after")
    def valid_references(self) -> Self:
        if len({reference.field_id for reference in self.fields}) != len(self.fields):
            raise ValueError("Widget fields must be distinct")
        if self.metric is not None and self.metric.expected_type not in {
            "number",
            "decimal",
            "int",
        }:
            raise ValueError("Widget metric must be numeric")
        return self


def _lock_widgets(*, charts: bool = False) -> Connection:
    bind = op.get_bind()
    # A busy target fails before data/schema changes; the parent pauses its API.
    bind.execute(sa.text("SET LOCAL lock_timeout = '5s'"))
    tables = "public.board_widgets, public.dashboard_widgets"
    if charts:
        tables += ", public.charts"
    bind.execute(sa.text(f"LOCK TABLE {tables} IN ACCESS EXCLUSIVE MODE"))
    return bind


def _validate_legacy_boards(bind: Connection, *, downgrade: bool = False) -> dict[str, int]:
    columns = "config, size, pinned" if downgrade else "config"
    result = bind.execute(
        sa.text(f"SELECT {columns} FROM public.board_widgets ORDER BY id").execution_options(
            stream_results=True, max_row_buffer=100
        )
    ).mappings()
    counts = {"rows": 0, "defaulted_size": 0, "defaulted_pinned": 0}
    try:
        for row in result:
            config = row["config"]
            if not isinstance(config, dict):
                raise RuntimeError("Saved chart migration refuses non-object Board config")
            candidate = config
            if downgrade:
                if row["size"] not in {"M", "L"} or type(row["pinned"]) is not bool:
                    raise RuntimeError("Saved chart downgrade refuses unrepresentable Board layout")
                legacy_size = "half" if row["size"] == "M" else "full"
                if ("size" in config and config["size"] != legacy_size) or (
                    "pinned" in config and config["pinned"] is not row["pinned"]
                ):
                    raise RuntimeError("Saved chart downgrade refuses conflicting layout keys")
                candidate = {**config, "size": legacy_size, "pinned": row["pinned"]}
            try:
                _LegacyBoardConfig.model_validate(candidate)
            except ValidationError:
                # No query values, IDs or validation payloads enter operator output.
                raise RuntimeError(
                    "Saved chart migration refuses invalid legacy Board config"
                ) from None
            counts["rows"] += 1
            counts["defaulted_size"] += int("size" not in config)
            counts["defaulted_pinned"] += int("pinned" not in config)
    finally:
        result.close()
    return counts


def _preflight_upgrade() -> tuple[Connection, dict[str, int], int]:
    bind = _lock_widgets()
    boards = _validate_legacy_boards(bind)
    dashboards = int(bind.scalar(sa.text("SELECT count(*) FROM public.dashboard_widgets")))
    print(
        f"Saved chart upgrade validated {boards['rows']} Board widgets "
        f"({boards['defaulted_size']} default sizes, {boards['defaulted_pinned']} default pins) "
        f"and {dashboards} Dashboard widgets"
    )
    return bind, boards, dashboards


def _preflight_downgrade() -> tuple[Connection, dict[str, int], int]:
    bind = _lock_widgets(charts=True)
    blocked = (
        bind.execute(
            sa.text("""
        SELECT
            (SELECT count(*) FROM public.charts) AS charts,
            (SELECT count(*) FROM public.board_widgets WHERE chart_id IS NOT NULL) AS board_refs,
            (SELECT count(*) FROM public.dashboard_widgets WHERE chart_id IS NOT NULL)
                AS dashboard_refs,
            (SELECT count(*) FROM public.board_widgets WHERE size NOT IN ('M', 'L')) AS board_sizes,
            (SELECT count(*) FROM public.dashboard_widgets WHERE size <> 'M') AS dashboard_sizes,
            (SELECT count(*) FROM public.board_widgets WHERE config ? 'query')
                AS normalized_configs,
            (SELECT count(*) FROM public.dashboard_widgets WHERE config IS NULL) AS null_configs
    """)
        )
        .mappings()
        .one()
    )
    if any(blocked.values()):
        raise RuntimeError(
            "Saved chart downgrade refused: retained Charts, references or widget data "
            "cannot fit the predecessor schema without loss"
        )
    boards = _validate_legacy_boards(bind, downgrade=True)
    dashboards = int(bind.scalar(sa.text("SELECT count(*) FROM public.dashboard_widgets")))
    print(
        f"Saved chart downgrade validated {boards['rows']} Board and {dashboards} Dashboard widgets"
    )
    return bind, boards, dashboards


def _backfill_layout(bind: Connection, expected_rows: int, *, downgrade: bool = False) -> None:
    statement = (
        """UPDATE public.board_widgets
           SET config = config || jsonb_build_object(
               'size', CASE size WHEN 'M' THEN 'half' WHEN 'L' THEN 'full' END,
               'pinned', pinned)
        """
        if downgrade
        else """UPDATE public.board_widgets
           SET size = CASE WHEN config ->> 'size' = 'full' THEN 'L' ELSE 'M' END,
               pinned = COALESCE((config ->> 'pinned')::boolean, false),
               config = config - 'size' - 'pinned'
        """
    )
    changed = bind.execute(sa.text(statement)).rowcount
    if changed != expected_rows:
        raise RuntimeError("Saved chart layout backfill row count changed")


def _assert_widget_counts(bind: Connection, board_count: int, dashboard_count: int) -> None:
    counts = (
        bind.execute(
            sa.text("""
        SELECT (SELECT count(*) FROM public.board_widgets) AS boards,
               (SELECT count(*) FROM public.dashboard_widgets) AS dashboards
    """)
        )
        .mappings()
        .one()
    )
    if counts["boards"] != board_count or counts["dashboards"] != dashboard_count:
        raise RuntimeError("Saved chart migration changed retained widget counts")


def upgrade() -> None:
    bind, boards, dashboard_count = _preflight_upgrade()
    # Table/column/FK/index operations started from Alembic autogenerate.
    # Existing-table CHECKs, role grants and lossless layout moves are deliberate.
    op.create_table(
        "charts",
        sa.Column("department_id", sa.UUID(), nullable=False),
        sa.Column("module_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("chart_type", sa.String(length=20), nullable=False),
        sa.Column("query", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
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
        sa.CheckConstraint(
            "chart_type IN ('bar', 'line', 'pie', 'summary', 'workload', 'records')",
            name="ck_charts_type",
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name="ck_charts_name_nonempty"),
        sa.CheckConstraint("revision > 0", name="ck_charts_revision_positive"),
        sa.ForeignKeyConstraint(
            ["department_id"],
            ["departments.id"],
            name=op.f("fk_charts_department_id_departments"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["module_id"],
            ["modules.id"],
            name=op.f("fk_charts_module_id_modules"),
            ondelete="RESTRICT",
        ),
        # Users already exists. Inline the inherited use_alter FK: CreateTable
        # otherwise suppresses it without an Alembic follow-up AddConstraint.
        sa.ForeignKeyConstraint(
            ["performed_by"],
            ["users.id"],
            name=op.f("fk_charts_performed_by_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("charts_pkey")),
    )
    op.create_index("ix_charts_department_id", "charts", ["department_id"], unique=False)
    op.create_index("ix_charts_module_id", "charts", ["module_id"], unique=False)
    op.execute("REVOKE ALL ON TABLE public.charts FROM PUBLIC, anon, authenticated, service_role")
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.charts TO openslate_app")
    op.add_column(
        "board_widgets",
        sa.Column("size", sa.String(length=1), server_default=sa.text("'M'"), nullable=False),
    )
    op.add_column(
        "board_widgets",
        sa.Column("pinned", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column("board_widgets", sa.Column("chart_id", sa.UUID(), nullable=True))
    _backfill_layout(bind, boards["rows"])
    op.alter_column(
        "board_widgets",
        "config",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        nullable=True,
    )
    op.create_index("ix_board_widgets_chart_id", "board_widgets", ["chart_id"], unique=False)
    op.create_foreign_key(
        op.f("fk_board_widgets_chart_id_charts"),
        "board_widgets",
        "charts",
        ["chart_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_check_constraint("ck_board_widgets_size", "board_widgets", "size IN ('S', 'M', 'L')")
    op.create_check_constraint(
        "ck_board_widgets_query_source",
        "board_widgets",
        "(config IS NOT NULL) <> (chart_id IS NOT NULL)",
    )
    op.add_column(
        "dashboard_widgets",
        sa.Column("size", sa.String(length=1), server_default=sa.text("'M'"), nullable=False),
    )
    op.add_column("dashboard_widgets", sa.Column("chart_id", sa.UUID(), nullable=True))
    op.alter_column(
        "dashboard_widgets",
        "config",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        nullable=True,
    )
    op.create_index(
        "ix_dashboard_widgets_chart_id", "dashboard_widgets", ["chart_id"], unique=False
    )
    op.create_foreign_key(
        op.f("fk_dashboard_widgets_chart_id_charts"),
        "dashboard_widgets",
        "charts",
        ["chart_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_check_constraint(
        "ck_dashboard_widgets_size", "dashboard_widgets", "size IN ('S', 'M', 'L')"
    )
    op.create_check_constraint(
        "ck_dashboard_widgets_query_source",
        "dashboard_widgets",
        "(config IS NOT NULL) <> (chart_id IS NOT NULL)",
    )
    _assert_widget_counts(bind, boards["rows"], dashboard_count)


def downgrade() -> None:
    bind, boards, dashboard_count = _preflight_downgrade()
    _backfill_layout(bind, boards["rows"], downgrade=True)
    op.drop_constraint("ck_dashboard_widgets_query_source", "dashboard_widgets", type_="check")
    op.drop_constraint("ck_dashboard_widgets_size", "dashboard_widgets", type_="check")
    op.drop_constraint(
        op.f("fk_dashboard_widgets_chart_id_charts"), "dashboard_widgets", type_="foreignkey"
    )
    op.drop_index("ix_dashboard_widgets_chart_id", table_name="dashboard_widgets")
    op.alter_column(
        "dashboard_widgets",
        "config",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        nullable=False,
    )
    op.drop_column("dashboard_widgets", "chart_id")
    op.drop_column("dashboard_widgets", "size")
    op.drop_constraint("ck_board_widgets_query_source", "board_widgets", type_="check")
    op.drop_constraint("ck_board_widgets_size", "board_widgets", type_="check")
    op.drop_constraint(
        op.f("fk_board_widgets_chart_id_charts"), "board_widgets", type_="foreignkey"
    )
    op.drop_index("ix_board_widgets_chart_id", table_name="board_widgets")
    op.alter_column(
        "board_widgets",
        "config",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        nullable=False,
    )
    op.drop_column("board_widgets", "chart_id")
    op.drop_column("board_widgets", "pinned")
    op.drop_column("board_widgets", "size")
    op.drop_index("ix_charts_module_id", table_name="charts")
    op.drop_index("ix_charts_department_id", table_name="charts")
    op.drop_table("charts")
    _assert_widget_counts(bind, boards["rows"], dashboard_count)
