"""Foundation Board plans, pledge scenario, and OpenView content data."""

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
from operations.sample.packs.nonprofit import content_text as text
from operations.sample.packs.nonprofit.ledger import PLEDGE_PAYMENT, PLEDGE_TOTAL
from operations.sample.packs.nonprofit.people import DEPARTMENT_KEYS, LEADS, TEAM_GROUPS

_DEPARTMENT_GROUPS = {key: (TEAM_GROUPS[key], "write") for key in DEPARTMENT_KEYS}

PROJECTS = (
    ("Typhoon Response Readiness", "programs"),
    ("Year-End Appeal Planning", "resource_mobilization"),
    ("Annual Audit Preparation", "finance"),
)

_POST_STATES = ("draft", "published", "scheduled", "archived")
_LAYOUTS = ("table", "grid", "gallery")
_REMINDERS = ("start", "15m", "1d")

# Blank attachments on seeded posts (indexes 0-5 stay visible) and events. None sit on the
# control anchor Board (Annual Audit Preparation), whose files the controls add and remove.
BOARD_FILES = tuple(
    BoardFileSpec(f"file:{board}:{kind}:{index}", board, kind, index, filename)
    for board, kind, index, filename in (
        ("department:resource_mobilization", "post", 0, "Appeal page copy.docx"),
        ("department:grants_partnerships", "post", 0, "Q2 interim financial report.pdf"),
        ("department:programs", "event", 1, "Round 2 distribution lists.xlsx"),
        ("department:meal", "post", 0, "PDM results summary.pptx"),
        ("department:finance", "post", 0, "Advances over 30 days.xlsx"),
        ("department:procurement", "post", 0, "Shelter kit sample photo.jpeg"),
        ("department:volunteer_engagement", "event", 2, "Repacking floor plan.png"),
        ("department:executive_office", "post", 3, "Safeguarding policy draft.docx"),
        ("project:programs:typhoon-response-readiness", "post", 1, "Standby agreements.pdf"),
        ("project:resource_mobilization:year-end-appeal-planning", "event", 0,
         "Appeal photo shortlist.jpg"),
        ("company", "post", 2, "Holiday office hours.pdf"),
    )
)

# The Procurement Board's demo Kanban: 5 stages, 3 labels, 12 cards (4 records).
_KANBAN = KanbanSpec(
    board="department:procurement",
    stages=(
        ("Requested", "chart-1"),
        ("Quotes", "chart-2"),
        ("PO issued", "chart-3"),
        ("Delivered", "chart-4"),
        ("Closed", "chart-5"),
    ),
    labels=(("Urgent", "chart-1"), ("Typhoon response", "chart-2"), ("Office", "chart-3")),
    cards=(
        KanbanCardSpec(0, "Quotes for 400 shelter repair kits", labels=(1,), due_in_days=10),
        KanbanCardSpec(0, "Replace the office printer", labels=(2,), due_in_days=21),
        KanbanCardSpec(1, record="purchase_requests:000002", labels=(1,), due_in_days=5),
        KanbanCardSpec(1, "Renew the trucking standby agreement", labels=(0,), due_in_days=7,
                       checklist=("Ask two more truckers for rates", "Check the insurance")),
        KanbanCardSpec(1, record="purchase_requests:000003"),
        KanbanCardSpec(2, record="purchase_orders:000002", labels=(1,), due_in_days=3),
        KanbanCardSpec(2, "Pre-position rice for the island sites", labels=(1,),
                       description="Confirm the boat schedule with Programs first.",
                       checklist=("Book the boat", "Tell the site facilitators",
                                  "Update the stock card")),
        KanbanCardSpec(2, "Order tarpaulins for the warehouse roof", due_in_days=6),
        KanbanCardSpec(3, record="purchase_orders:000003", labels=(0,), due_in_days=2),
        KanbanCardSpec(3, "Count the hygiene kit stock", labels=(0,), due_in_days=4),
        KanbanCardSpec(4, "Supplier accreditation files", labels=(2,),
                       checklist=("Check the permits", "File the tax clearance")),
        KanbanCardSpec(4, "Archive last year's bid documents"),
    ),
)  # fmt: skip


def content_spec() -> ContentSpec:
    """Return the foundation's content used by shared Board and OpenView flows."""
    return ContentSpec(
        department_groups=_DEPARTMENT_GROUPS,
        leads=LEADS,
        projects=PROJECTS,
        project_groups=(("fcdf-staff", "write"), ("audit-guests", "read")),
        required_modules=(
            ("pledges", "resource_mobilization"),
            ("donations", "resource_mobilization"),
            ("cash_advances", "finance"),
            ("expense_lines", "finance"),
        ),
        company_source_department="finance",
        required_records={
            "pledges:000001": "pledges",
            "donations:000001": "donations",
            "cash_advances:000001": "cash_advances",
            "expense_lines:000001": "expense_lines",
        },
        amounts=(
            MoneySpec("pledge_total", "pledges:000001", "Total pledged ₱", Decimal(PLEDGE_TOTAL)),
            MoneySpec("payment_amount", "donations:000001", "Amount ₱", Decimal(PLEDGE_PAYMENT)),
        ),
        scenario_total=Decimal(PLEDGE_TOTAL),
        scenario_paid=Decimal(PLEDGE_PAYMENT),
        scenario_balance=Decimal(PLEDGE_TOTAL - PLEDGE_PAYMENT),
        board_links=(
            BoardLinkSpec("link:pledge-post", "post", "department:resource_mobilization", 2,
                          ("pledges:000001", "donations:000001")),
            BoardLinkSpec("link:advance-event", "event", "department:finance", 0,
                          ("cash_advances:000001", "expense_lines:000001")),
        ),  # fmt: skip
        board_files=BOARD_FILES,
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


KANBAN = _KANBAN
