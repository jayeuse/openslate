"""School Board plans, fee scenario, and OpenView content data."""

from __future__ import annotations

from decimal import Decimal

from operations.sample.packs.content_types import BoardLinkSpec, ContentSpec, MoneySpec
from operations.sample.packs.school import content_text as text
from operations.sample.packs.school.people import DEPARTMENT_KEYS, TEAM_GROUPS

_DEPARTMENT_GROUPS = {key: (TEAM_GROUPS[key], "write") for key in DEPARTMENT_KEYS}
_LEADS = {key: f"internal_{key}_lead" for key in DEPARTMENT_KEYS}

_PROJECTS = (
    ("Parents' Evening Planning", "academic"),
    ("Clubs and Enrichment Programme", "student_affairs"),
    ("Site Safety Review", "facilities"),
)

_POST_STATES = ("draft", "published", "scheduled", "archived")
_LAYOUTS = ("table", "grid", "gallery", "kanban", "calendar", "timeline")
_REMINDERS = ("start", "15m", "1d")


def content_spec() -> ContentSpec:
    """Return School-specific content used by shared Board and OpenView flows."""
    return ContentSpec(
        department_groups=_DEPARTMENT_GROUPS,
        leads=_LEADS,
        projects=_PROJECTS,
        project_groups=(("school-staff", "write"), ("guest-auditors", "read")),
        required_modules=(
            ("fee_assessments", "finance"),
            ("payments", "finance"),
            ("students", "academic"),
            ("class_sections", "academic"),
        ),
        company_source_department="finance",
        required_records={
            "fee_assessments:000001": "fee_assessments",
            "payments:000001": "payments",
            "students:000001": "students",
            "class_sections:000001": "class_sections",
        },
        amounts=(
            MoneySpec("assessment_total", "fee_assessments:000001", "Net due £", Decimal(4_200)),
            MoneySpec("payment_amount", "payments:000001", "Amount £", Decimal(1_600)),
        ),
        scenario_total=Decimal(4_200),
        scenario_paid=Decimal(1_600),
        scenario_balance=Decimal(2_600),
        board_links=(
            BoardLinkSpec(
                "link:finance-post",
                "post",
                "department:finance",
                2,
                ("fee_assessments:000001", "payments:000001"),
            ),
            BoardLinkSpec(
                "link:academic-event",
                "event",
                "department:academic",
                0,
                ("students:000001", "class_sections:000001"),
            ),
        ),
        post_states=_POST_STATES,
        posts_per_board=8,
        events_per_board=12,
        event_titles=text.EVENT_TITLES,
        event_details=text.EVENT_DETAILS,
        event_locations=text.EVENT_LOCATIONS,
        reminders=_REMINDERS,
        layouts=_LAYOUTS,
        posts=text.POSTS,
        board_descriptions=text.BOARD_DESCRIPTIONS,
        layout_names=text.LAYOUT_NAMES,
        post_text=text.post_text,
        revised_post=text.revised_post,
        project_board=text.project_board,
        view_name=text.view_name,
        dashboard_name=text.dashboard_name,
        report_names=text.report_names,
    )
