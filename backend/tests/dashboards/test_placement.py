"""Dashboard grid rules without a database: bounds, overlap and each kind's size range."""

import pytest

from app.systems.openview.dashboards.placement import Placement, layout_issues, widget_kind


@pytest.mark.parametrize(
    ("widget_type", "chart_type", "kind"),
    [
        ("summary", None, "number"),
        ("summary", "summary", "number"),
        ("workload", None, "table"),
        ("records", None, "records"),
        ("chart", "bar", "bar"),
        ("chart", "line", "line"),
        ("chart", "pie", "pie"),
    ],
)
def test_widget_kind_follows_the_widget_type_then_the_chart_type(widget_type, chart_type, kind):
    assert widget_kind(widget_type, chart_type) == kind


@pytest.mark.parametrize(
    ("kind", "columns", "rows", "allowed"),
    [
        # Number: 1 x 1 to 2 x 1.
        ("number", 1, 1, True),
        ("number", 2, 1, True),
        ("number", 3, 1, False),
        ("number", 1, 2, False),
        # Bar and line: 2 x 2 to 4 x 3.
        ("bar", 2, 2, True),
        ("bar", 4, 3, True),
        ("bar", 1, 2, False),
        ("bar", 2, 1, False),
        ("bar", 4, 4, False),
        ("line", 4, 3, True),
        ("line", 4, 4, False),
        # Pie: 2 x 2 to 3 x 3.
        ("pie", 3, 3, True),
        ("pie", 4, 2, False),
        ("pie", 2, 4, False),
        # Table and records list: 2 x 2 to 4 x 5.
        ("table", 2, 2, True),
        ("table", 4, 5, True),
        ("table", 1, 5, False),
        ("records", 4, 5, True),
        ("records", 2, 1, False),
    ],
)
def test_each_kind_takes_only_the_sizes_in_its_size_rule(kind, columns, rows, allowed):
    issues = layout_issues([(kind, Placement(0, 0, columns, rows))])

    assert [(issue.index, issue.code) for issue in issues] == (
        [] if allowed else [(0, "size_not_allowed")]
    )


@pytest.mark.parametrize(
    "placement",
    [
        Placement(3, 0, 2, 2),  # past the fourth column
        Placement(0, 4, 2, 2),  # past the fifth row
        Placement(2, 3, 4, 2),  # both
    ],
)
def test_a_widget_that_leaves_the_grid_is_refused(placement):
    issues = layout_issues([("table", placement)])

    assert [(issue.index, issue.code) for issue in issues] == [(0, "outside_grid")]


def test_overlap_is_refused_on_the_later_widget_and_touching_edges_are_allowed():
    issues = layout_issues(
        [
            ("bar", Placement(0, 1, 2, 2)),
            ("line", Placement(2, 1, 2, 2)),  # touches the bar's right edge
            ("number", Placement(0, 0, 2, 1)),  # touches the bar's top edge
            ("records", Placement(1, 2, 2, 3)),  # covers a bar cell and a line cell
        ]
    )

    assert [(issue.index, issue.code, issue.message) for issue in issues] == [
        (3, "overlap", "This widget overlaps widget 1"),
    ]


def test_a_full_grid_of_twenty_numbers_fits():
    widgets = [("number", Placement(column, row, 1, 1)) for row in range(5) for column in range(4)]

    assert layout_issues(widgets) == []
    extra = layout_issues([*widgets, ("number", Placement(0, 0, 1, 1))])
    assert [(issue.index, issue.code) for issue in extra] == [(20, "overlap")]
