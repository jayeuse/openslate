"""Sauce plant Board plans, invoice scenario, and OpenView content data."""

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
from operations.sample.packs.manufacturer import content_text as text
from operations.sample.packs.manufacturer.money import (
    SCENARIO_BALANCE,
    SCENARIO_PAID,
    SCENARIO_TOTAL,
)
from operations.sample.packs.manufacturer.people import DEPARTMENT_KEYS, TEAM_GROUPS

_DEPARTMENT_GROUPS = {key: (TEAM_GROUPS[key], "write") for key in DEPARTMENT_KEYS}
_LEADS = {key: f"internal_{key}_lead" for key in DEPARTMENT_KEYS}

PROJECTS = (
    ("Holiday Peak Production Plan", "manufacturing"),
    ("GFSI Certification Audit", "quality"),
    ("December Shutdown", "maintenance"),
)
PROJECT_GROUPS = (("plant-staff", "write"), ("food-safety-auditors", "read"))
POST_STATES = ("draft", "published", "scheduled", "archived")
LAYOUTS = ("table", "grid", "gallery")
REMINDERS = ("start", "15m", "1d")
POSTS_PER_BOARD = 8
EVENTS_PER_BOARD = 12

# Blank attachments on seeded posts (indexes 0-5 stay visible) and events. None sit on the
# control anchor Board (GFSI Certification Audit), whose files the controls add and remove.
BOARD_FILES = tuple(
    BoardFileSpec(f"file:{board}:{kind}:{index}", board, kind, index, filename)
    for board, kind, index, filename in (
        ("department:sales", "post", 0, "Spring promotion calendar.xlsx"),
        ("department:sales", "event", 11, "Plant visit agenda.docx"),
        ("department:planning", "post", 1, "Paste forecast by family.xlsx"),
        ("department:warehouse", "post", 0, "Carrier cutoff dates.pdf"),
        ("department:manufacturing", "post", 0, "Lockout and tagout steps.pdf"),
        ("department:manufacturing", "event", 3, "Line 2 layout.png"),
        ("department:quality", "post", 4, "Record review checklist.docx"),
        ("department:maintenance", "post", 0, "Shutdown job list.xlsx"),
        ("department:finance", "post", 0, "Close calendar.pdf"),
        ("project:manufacturing:holiday-peak-production-plan", "post", 0, "Peak build plan.pptx"),
        ("project:maintenance:december-shutdown", "post", 3, "Filler bowl before rebuild.jpg"),
        ("company", "post", 1, "Safety milestone banner.jpeg"),
    )
)  # fmt: skip

# The Production department Board's demo Kanban: 5 stages, 3 labels, 12 cards (4 records).
KANBAN = KanbanSpec(
    board="department:manufacturing",
    stages=(
        ("Reported", "chart-1"),
        ("Scheduled", "chart-2"),
        ("In progress", "chart-3"),
        ("Checking", "chart-4"),
        ("Done", "chart-5"),
    ),
    labels=(("Urgent", "chart-1"), ("Safety", "chart-2"), ("Changeover", "chart-3")),
    cards=(
        KanbanCardSpec(0, "Fix the guard on the L1 case packer", labels=(1,), due_in_days=3),
        KanbanCardSpec(0, record="downtime_events:000003", labels=(0,), due_in_days=2),
        KanbanCardSpec(1, record="batch_records:000004", due_in_days=1),
        KanbanCardSpec(1, "Cut the L2 changeover to 35 minutes", labels=(2,), due_in_days=14,
                       checklist=("Film the next changeover", "List the steps done in parallel")),
        KanbanCardSpec(1, record="shift_reports:000002"),
        KanbanCardSpec(2, record="downtime_events:000004", labels=(0,), due_in_days=2),
        KanbanCardSpec(2, "Train the new packers on L3", labels=(1,),
                       description="Pair each new packer with a trained packer for a week.",
                       checklist=("GMP training", "Allergen training", "Lockout briefing")),
        KanbanCardSpec(2, "Post the Saturday overtime sign-up", due_in_days=4),
        KanbanCardSpec(3, "Check the new fill weights on L2", labels=(2,), due_in_days=3),
        KanbanCardSpec(3, "Review last week's downtime top five", due_in_days=5),
        KanbanCardSpec(4, "Replace the worn capper chuck inserts", labels=(0,),
                       checklist=("Order the inserts", "Fit and torque check")),
        KanbanCardSpec(4, "Repaint the walkway lines on the floor"),
    ),
)  # fmt: skip


def content_spec() -> ContentSpec:
    """Return the sauce plant's content used by shared Board and OpenView flows."""
    return ContentSpec(
        department_groups=_DEPARTMENT_GROUPS,
        leads=_LEADS,
        projects=PROJECTS,
        project_groups=PROJECT_GROUPS,
        required_modules=(
            ("customer_invoices", "finance"),
            ("customer_payments", "finance"),
            ("equipment", "maintenance"),
            ("maintenance_work_orders", "maintenance"),
        ),
        company_source_department="finance",
        required_records={
            "customer_invoices:000001": "customer_invoices",
            "customer_payments:000001": "customer_payments",
            "equipment:000001": "equipment",
            "maintenance_work_orders:000001": "maintenance_work_orders",
        },
        amounts=(
            MoneySpec("invoice_amount", "customer_invoices:000001", "Amount $",
                      Decimal(SCENARIO_TOTAL)),  # fmt: skip
            MoneySpec("payment_amount", "customer_payments:000001", "Amount $",
                      Decimal(SCENARIO_PAID)),  # fmt: skip
        ),
        scenario_total=Decimal(SCENARIO_TOTAL),
        scenario_paid=Decimal(SCENARIO_PAID),
        scenario_balance=Decimal(SCENARIO_BALANCE),
        board_links=(
            BoardLinkSpec(
                "link:finance-post",
                "post",
                "department:finance",
                2,
                ("customer_invoices:000001", "customer_payments:000001"),
            ),
            BoardLinkSpec(
                "link:maintenance-event",
                "event",
                "department:maintenance",
                0,
                ("equipment:000001", "maintenance_work_orders:000001"),
            ),
        ),
        board_files=BOARD_FILES,
        post_states=POST_STATES,
        posts_per_board=POSTS_PER_BOARD,
        events_per_board=EVENTS_PER_BOARD,
        event_titles=text.EVENT_TITLES,
        event_details=text.EVENT_DETAILS,
        event_locations=text.EVENT_LOCATIONS,
        reminders=REMINDERS,
        layouts=LAYOUTS,
        posts=text.POSTS,
        board_descriptions=text.BOARD_DESCRIPTIONS,
        layout_names=text.LAYOUT_NAMES,
        post_text=text.post_text,
        revised_post=text.revised_post,
        project_board=text.project_board,
        view_name=text.view_name,
        dashboard_name=text.dashboard_name,
        report_names=text.report_names,
        kanban=KANBAN,
    )
