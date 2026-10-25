"""Dashboard grid rules: 4 columns by 5 rows and the size range of each widget kind.

Pure rules only. The database checks bounds and spans; overlap and the per-kind size
ranges need the whole layout and a saved chart's type, so the save path checks them here.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from fastapi import HTTPException, status

GRID_COLUMNS = 4
GRID_ROWS = 5
GRID_CELLS = GRID_COLUMNS * GRID_ROWS

WidgetKind = Literal["number", "bar", "line", "pie", "table", "records"]
LayoutIssueCode = Literal["outside_grid", "size_not_allowed", "overlap"]


@dataclass(frozen=True)
class SizeRule:
    label: str
    min_columns: int
    min_rows: int
    max_columns: int
    max_rows: int

    def allows(self, columns: int, rows: int) -> bool:
        return (
            self.min_columns <= columns <= self.max_columns
            and self.min_rows <= rows <= self.max_rows
        )


# docs/specs/openview-dashboard.md, "Size rules (columns x rows)".
SIZE_RULES: dict[WidgetKind, SizeRule] = {
    "number": SizeRule("number", 1, 1, 2, 1),
    "bar": SizeRule("bar chart", 2, 2, 4, 3),
    "line": SizeRule("line chart", 2, 2, 4, 3),
    "pie": SizeRule("pie chart", 2, 2, 3, 3),
    "table": SizeRule("table", 2, 2, 4, 5),
    "records": SizeRule("records list", 2, 2, 4, 5),
}


@dataclass(frozen=True)
class Placement:
    column: int
    row: int
    column_span: int
    row_span: int

    def inside_grid(self) -> bool:
        return (
            self.column >= 0
            and self.row >= 0
            and self.column_span >= 1
            and self.row_span >= 1
            and self.column + self.column_span <= GRID_COLUMNS
            and self.row + self.row_span <= GRID_ROWS
        )

    def cells(self) -> list[tuple[int, int]]:
        return [
            (column, row)
            for row in range(self.row, self.row + self.row_span)
            for column in range(self.column, self.column + self.column_span)
        ]


@dataclass(frozen=True)
class LayoutIssue:
    index: int
    code: LayoutIssueCode
    message: str


def widget_kind(widget_type: str, chart_type: str | None) -> WidgetKind:
    """The size-rule kind: the widget type, or the chart type for a chart widget."""
    if widget_type == "summary":
        return "number"
    if widget_type == "workload":
        return "table"
    if widget_type == "records":
        return "records"
    if chart_type == "bar":
        return "bar"
    if chart_type == "line":
        return "line"
    if chart_type == "pie":
        return "pie"
    raise ValueError(f"Unknown dashboard widget kind: {widget_type}/{chart_type}")


def layout_issues(widgets: Sequence[tuple[WidgetKind, Placement]]) -> list[LayoutIssue]:
    """Every rule each widget breaks, in list order; an empty list means the layout fits."""
    issues: list[LayoutIssue] = []
    owners: dict[tuple[int, int], int] = {}
    for index, (kind, placement) in enumerate(widgets):
        rule = SIZE_RULES[kind]
        if not rule.allows(placement.column_span, placement.row_span):
            issues.append(
                LayoutIssue(
                    index,
                    "size_not_allowed",
                    f"A {rule.label} must be {rule.min_columns} × {rule.min_rows} to "
                    f"{rule.max_columns} × {rule.max_rows} (columns × rows)",
                )
            )
        if not placement.inside_grid():
            issues.append(
                LayoutIssue(
                    index,
                    "outside_grid",
                    f"This widget does not fit inside the {GRID_COLUMNS} × {GRID_ROWS} grid",
                )
            )
            continue
        cells = placement.cells()
        covered = sorted({owners[cell] for cell in cells if cell in owners})
        if covered:
            issues.append(
                LayoutIssue(index, "overlap", f"This widget overlaps widget {covered[0] + 1}")
            )
        for cell in cells:
            owners.setdefault(cell, index)
    return issues


def layout_invalid(issues: Sequence[LayoutIssue]) -> HTTPException:
    """422 with one entry per broken rule; nothing is saved."""
    return HTTPException(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail={
            "code": "dashboard_layout_invalid",
            "message": "The dashboard layout does not fit the grid",
            "errors": [
                {"index": issue.index, "code": issue.code, "message": issue.message}
                for issue in issues
            ],
        },
    )
