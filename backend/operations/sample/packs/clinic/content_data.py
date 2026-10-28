"""Clinic Board plans, claim scenario, and OpenView content data."""

from __future__ import annotations

from decimal import Decimal

from operations.sample.packs.clinic import content_text as text
from operations.sample.packs.clinic.people import DEPARTMENT_KEYS, TEAM_GROUPS
from operations.sample.packs.content_types import (
    BoardFileSpec,
    BoardLinkSpec,
    ContentSpec,
    KanbanCardSpec,
    KanbanSpec,
    MoneySpec,
)

_DEPARTMENT_GROUPS = {key: (TEAM_GROUPS[key], "write") for key in DEPARTMENT_KEYS}
_LEADS = {key: f"internal_{key}_lead" for key in DEPARTMENT_KEYS}

_PROJECTS = (
    ("Flu Vaccination Drive", "clinical"),
    ("Accreditation Readiness", "quality"),
    ("Year-End Stock Count", "pharmacy"),
)

_POST_STATES = ("draft", "published", "scheduled", "archived")
_LAYOUTS = ("table", "grid", "gallery")
_REMINDERS = ("start", "15m", "1d")

# Blank attachments on seeded posts (indexes 0-5 stay visible) and events. None sit on the
# control anchor Board (Accreditation Readiness), whose files the controls add and remove.
_BOARD_FILES = tuple(
    BoardFileSpec(f"file:{board}:{kind}:{index}", board, kind, index, filename)
    for board, kind, index, filename in (
        ("department:patient_access", "post", 0, "Insurance card checklist.pdf"),
        ("department:clinical", "post", 1, "Triage vitals procedure.docx"),
        ("department:clinical", "event", 2, "Holiday on-call roster.xlsx"),
        ("department:laboratory", "post", 2, "Critical value call list.pdf"),
        ("department:pharmacy", "post", 1, "Lot recall notice.pdf"),
        ("department:revenue_cycle", "post", 3, "Denials by reason.xlsx"),
        ("department:operations", "event", 1, "Maintenance week schedule.pdf"),
        ("department:quality", "post", 0, "Hand hygiene audit summary.pptx"),
        ("project:clinical:flu-vaccination-drive", "post", 2, "Flu clinic floor plan.png"),
        ("project:pharmacy:year-end-stock-count", "event", 0, "Count sheet template.xlsx"),
        ("company", "post", 2, "Holiday hours.pdf"),
    )
)

# The Operations department Board's demo Kanban: 5 stages, 3 labels, 12 cards (4 records).
_KANBAN = KanbanSpec(
    board="department:operations",
    stages=(
        ("Requested", "chart-1"),
        ("Quoted", "chart-2"),
        ("Ordered", "chart-3"),
        ("Delivered", "chart-4"),
        ("Closed", "chart-5"),
    ),
    labels=(("Urgent", "chart-1"), ("Pharmacy", "chart-2"), ("Facilities", "chart-3")),
    cards=(
        KanbanCardSpec(0, "Replace the waiting room chairs", labels=(2,), due_in_days=14),
        KanbanCardSpec(0, "Quote for a second vaccine fridge", labels=(1,), due_in_days=10),
        KanbanCardSpec(1, record="purchase_requests:000002", labels=(1,), due_in_days=5),
        KanbanCardSpec(1, "Review the new glove supplier", labels=(0,), due_in_days=7,
                       checklist=("Ask for a box of each size", "Compare the box price")),
        KanbanCardSpec(1, record="purchase_requests:000003"),
        KanbanCardSpec(2, record="maintenance_work_orders:000002", labels=(2,), due_in_days=3),
        KanbanCardSpec(2, "Plan the quarterly maintenance week", labels=(2,),
                       description="Book downtime with the lab and the pharmacy first.",
                       checklist=("List the devices due", "Book the contractor",
                                  "Tell the department leads")),
        KanbanCardSpec(2, "Order generator fuel", due_in_days=6),
        KanbanCardSpec(3, record="maintenance_work_orders:000003", labels=(0,), due_in_days=2),
        KanbanCardSpec(3, "Restock the exam room supply carts", labels=(0,), due_in_days=4),
        KanbanCardSpec(4, "Fire extinguisher inspection", labels=(2,),
                       checklist=("Check the tags", "Send the report to Quality")),
        KanbanCardSpec(4, "Sharps container pickup schedule"),
    ),
)  # fmt: skip


def content_spec() -> ContentSpec:
    """Return Clinic-specific content used by shared Board and OpenView flows."""
    return ContentSpec(
        department_groups=_DEPARTMENT_GROUPS,
        leads=_LEADS,
        projects=_PROJECTS,
        project_groups=(("clinic-staff", "write"), ("survey-guests", "read")),
        required_modules=(
            ("claims", "revenue_cycle"),
            ("payments", "revenue_cycle"),
            ("encounters", "clinical"),
            ("orders", "clinical"),
        ),
        company_source_department="revenue_cycle",
        required_records={
            "claims:000001": "claims",
            "payments:000001": "payments",
            "encounters:000001": "encounters",
            "orders:000001": "orders",
        },
        amounts=(
            MoneySpec("claim_total", "claims:000001", "Charge total $", Decimal(420)),
            MoneySpec("payment_amount", "payments:000001", "Amount $", Decimal(300)),
        ),
        scenario_total=Decimal(420),
        scenario_paid=Decimal(300),
        scenario_balance=Decimal(120),
        board_links=(
            BoardLinkSpec(
                "link:revenue-post",
                "post",
                "department:revenue_cycle",
                2,
                ("claims:000001", "payments:000001"),
            ),
            BoardLinkSpec(
                "link:clinical-event",
                "event",
                "department:clinical",
                0,
                ("encounters:000001", "orders:000001"),
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
