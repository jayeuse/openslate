"""dashboard grid placement and home

OpenView part B, BE1/BE1m/BE3 (docs/specs/openview-dashboard.md). Dashboard widgets move
from ``size`` (S, M, L) to explicit cells of a 4 x 5 grid, and each department gets one
active home Dashboard.

Data: the active widgets of every Dashboard are placed in ``position`` order, row by row,
at the first free space where the whole rectangle fits. A number (``summary``) S is 1 x 1,
M or L is 2 x 1; any other type S or M is 2 x 2, L is 4 x 2. A pie chart (inline or saved)
of size L takes the pie's largest size, 3 x 3, or 2 x 2 when 3 x 3 does not fit, since a pie
is at most 3 columns wide. A widget that does not fit stays unplaced (all four placement
columns null); a manager places or removes it. The first active Dashboard of each
department by ``position`` (then ``id``) becomes its home.

Overlap and the per-type size ranges are checked by the save path, not by the database:
overlap would need an exclusion constraint over ``btree_gist``, which this schema does not
install, and a saved chart's type lives in ``charts``.

Downgrade restores ``size`` from the spans (a 1-column number is S, a 3- or 4-column widget
is L, everything else and unplaced widgets are M) and refuses while a Dashboard holds a widget
at position 12 or later, which the old 12-widget limit cannot store. It does not restore
the original sizes of widgets that the upgrade mapped to the same span.

Revision ID: a6c970033eaa
Revises: 5a5ccb851c11
Create Date: 2026-10-26 01:56:03.170714
"""

from collections.abc import Sequence
from uuid import UUID

import sqlalchemy as sa
from alembic import op

revision: str = "a6c970033eaa"
down_revision: str | None = "5a5ccb851c11"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

GRID_COLUMNS = 4
GRID_ROWS = 5
PLACEMENT_CHECK = (
    "(grid_column IS NULL AND grid_row IS NULL AND column_span IS NULL "
    "AND row_span IS NULL) OR (grid_column IS NOT NULL AND grid_row IS NOT NULL "
    "AND column_span IS NOT NULL AND row_span IS NOT NULL "
    "AND grid_column >= 0 AND grid_row >= 0 AND column_span >= 1 AND row_span >= 1 "
    "AND grid_column + column_span <= 4 AND grid_row + row_span <= 5)"
)


def _spans(widget_type: str, chart_type: str | None, size: str) -> list[tuple[int, int]]:
    """Candidate (columns, rows) sizes, tried in order at the first free space."""
    if widget_type == "summary":
        return [(1, 1) if size == "S" else (2, 1)]
    if size != "L":
        return [(2, 2)]
    if widget_type == "chart" and chart_type == "pie":
        return [(3, 3), (2, 2)]
    return [(4, 2)]


def _first_free(
    occupied: set[tuple[int, int]], spans: list[tuple[int, int]]
) -> tuple[int, int, int, int] | None:
    for columns, rows in spans:
        for row in range(GRID_ROWS - rows + 1):
            for column in range(GRID_COLUMNS - columns + 1):
                cells = {
                    (column + x, row + y) for y in range(rows) for x in range(columns)
                }
                if not cells & occupied:
                    occupied.update(cells)
                    return column, row, columns, rows
    return None


def _place_existing_widgets(connection: sa.Connection) -> None:
    rows = connection.execute(
        sa.text(
            "SELECT w.id, w.dashboard_id, w.widget_type, "
            "COALESCE(w.config ->> 'chart_type', c.chart_type) AS chart_type, w.size "
            "FROM public.dashboard_widgets w LEFT JOIN public.charts c ON c.id = w.chart_id "
            "WHERE w.is_deleted = false ORDER BY w.dashboard_id, w.position, w.id"
        )
    ).all()
    occupied: dict[UUID, set[tuple[int, int]]] = {}
    for widget_id, dashboard_id, widget_type, chart_type, size in rows:
        spans = _spans(widget_type, chart_type, size)
        placed = _first_free(occupied.setdefault(dashboard_id, set()), spans)
        if placed is None:
            continue
        connection.execute(
            sa.text(
                "UPDATE public.dashboard_widgets SET grid_column = :column, grid_row = :row, "
                "column_span = :columns, row_span = :rows WHERE id = :id"
            ),
            {
                "id": widget_id,
                "column": placed[0],
                "row": placed[1],
                "columns": placed[2],
                "rows": placed[3],
            },
        )


def upgrade() -> None:
    op.add_column("dashboard_widgets", sa.Column("grid_column", sa.Integer(), nullable=True))
    op.add_column("dashboard_widgets", sa.Column("grid_row", sa.Integer(), nullable=True))
    op.add_column("dashboard_widgets", sa.Column("column_span", sa.Integer(), nullable=True))
    op.add_column("dashboard_widgets", sa.Column("row_span", sa.Integer(), nullable=True))
    _place_existing_widgets(op.get_bind())
    op.create_check_constraint(
        "ck_dashboard_widgets_placement", "dashboard_widgets", sa.text(PLACEMENT_CHECK)
    )
    op.drop_column("dashboard_widgets", "size")
    op.drop_constraint("ck_dashboard_widgets_position", "dashboard_widgets", type_="check")
    op.create_check_constraint(
        "ck_dashboard_widgets_position",
        "dashboard_widgets",
        sa.text("position >= 0 AND position < 20"),
    )

    op.add_column(
        "dashboards",
        sa.Column("is_home", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.execute(
        sa.text(
            "UPDATE public.dashboards SET is_home = true WHERE id IN ("
            "SELECT DISTINCT ON (org_id, department_id) id FROM public.dashboards "
            "WHERE is_deleted = false ORDER BY org_id, department_id, position, id)"
        )
    )
    op.create_index(
        "uq_dashboards_department_home",
        "dashboards",
        ["org_id", "department_id"],
        unique=True,
        postgresql_where=sa.text("is_home AND NOT is_deleted"),
    )


def downgrade() -> None:
    connection = op.get_bind()
    if connection.scalar(
        sa.text("SELECT EXISTS (SELECT 1 FROM public.dashboard_widgets WHERE position >= 12)")
    ):
        raise RuntimeError(
            "A Dashboard holds more than 12 widgets; remove them before downgrading"
        )
    op.drop_index(
        "uq_dashboards_department_home",
        table_name="dashboards",
        postgresql_where=sa.text("is_home AND NOT is_deleted"),
    )
    op.drop_column("dashboards", "is_home")

    op.add_column(
        "dashboard_widgets",
        sa.Column(
            "size", sa.VARCHAR(length=1), server_default=sa.text("'M'"), nullable=False
        ),
    )
    op.execute(
        sa.text(
            "UPDATE public.dashboard_widgets SET size = CASE "
            "WHEN widget_type = 'summary' AND column_span = 1 THEN 'S' "
            "WHEN widget_type <> 'summary' AND column_span >= 3 THEN 'L' "
            "ELSE 'M' END"
        )
    )
    op.create_check_constraint(
        "ck_dashboard_widgets_size", "dashboard_widgets", sa.text("size IN ('S', 'M', 'L')")
    )
    op.drop_constraint("ck_dashboard_widgets_position", "dashboard_widgets", type_="check")
    op.create_check_constraint(
        "ck_dashboard_widgets_position",
        "dashboard_widgets",
        sa.text("position >= 0 AND position < 12"),
    )
    op.drop_constraint("ck_dashboard_widgets_placement", "dashboard_widgets", type_="check")
    op.drop_column("dashboard_widgets", "row_span")
    op.drop_column("dashboard_widgets", "column_span")
    op.drop_column("dashboard_widgets", "grid_row")
    op.drop_column("dashboard_widgets", "grid_column")
