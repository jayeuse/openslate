"""School Board plans, fee scenario, and OpenView content data."""

from __future__ import annotations

from decimal import Decimal

from operations.sample.packs.content_types import (
    BoardFileSpec,
    BoardLinkSpec,
    ContentSpec,
    KanbanCardSpec,
    KanbanSpec,
    MoneySpec,
)
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

# Blank attachments on seeded posts (indexes 0-5 stay visible) and events. None sit on
# the control anchor Board (Site Safety Review), whose files the controls add and remove.
_BOARD_FILES = tuple(
    BoardFileSpec(f"file:{board}:{kind}:{index}", board, kind, index, filename)
    for board, kind, index, filename in (
        ("department:student_affairs", "post", 0, "Year 9 trip consent form.docx"),
        ("department:facilities", "post", 2, "Fire drill route.pdf"),
        ("department:facilities", "event", 4, "Boiler room inspection photo.jpeg"),
        ("department:academic", "post", 4, "Spring timetable changes.xlsx"),
        ("department:admissions", "event", 1, "Open morning campus map.png"),
        ("department:health", "post", 2, "Allergy action plan template.docx"),
        ("department:finance", "post", 0, "Lunch account top-up guide.pdf"),
        ("department:hr", "event", 2, "Staff induction slides.pptx"),
        ("project:academic:parents-evening-planning", "event", 0, "Evening room plan.pptx"),
        ("project:student_affairs:clubs-and-enrichment-programme", "post", 1, "Clubs fair.jpg"),
        ("company", "post", 3, "Term dates for next year.pdf"),
    )
)

# The Academic department Board's demo Kanban: 5 stages, 3 labels, 12 cards (4 record cards).
_KANBAN = KanbanSpec(
    board="department:academic",
    stages=(
        ("Ideas", "chart-1"),
        ("Planned", "chart-2"),
        ("In progress", "chart-3"),
        ("Review", "chart-4"),
        ("Done", "chart-5"),
    ),
    labels=(("Exams", "chart-1"), ("Parents", "chart-2"), ("Staff", "chart-3")),
    cards=(
        KanbanCardSpec(0, "Peer reading pairs for Year 7", labels=(2,)),
        KanbanCardSpec(0, "Revision café after school", labels=(0,), due_in_days=10),
        KanbanCardSpec(1, record="courses:000001", labels=(0,), due_in_days=5),
        KanbanCardSpec(1, "Plan the science fair judging", labels=(2,), due_in_days=8,
                       checklist=("Invite judges", "Book the hall")),
        KanbanCardSpec(1, record="courses:000002"),
        KanbanCardSpec(2, record="assessments:000001", labels=(0,), due_in_days=3),
        KanbanCardSpec(2, "Update the homework policy", labels=(1, 2),
                       description="Reflect the parent survey in the new policy.",
                       checklist=("Summarise the survey", "Draft the changes",
                                  "Share with heads of year")),
        KanbanCardSpec(2, "Order the new maths textbooks", due_in_days=6),
        KanbanCardSpec(3, record="assessments:000002", labels=(0,), due_in_days=2),
        KanbanCardSpec(3, "Mock exam seating plan", labels=(0,), due_in_days=4),
        KanbanCardSpec(4, "Parents' guide to options", labels=(1,),
                       checklist=("Proofread", "Send to the office")),
        KanbanCardSpec(4, "Timetable the spring clubs"),
    ),
)


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
        board_files=_BOARD_FILES,
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
        kanban=_KANBAN,
    )
