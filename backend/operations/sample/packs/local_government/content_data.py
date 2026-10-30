"""City government Board plans, installment scenario, and OpenView content data."""

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
from operations.sample.packs.local_government import content_text as text
from operations.sample.packs.local_government.money import (
    SCENARIO_BALANCE,
    SCENARIO_DUE,
    SCENARIO_PAID,
)
from operations.sample.packs.local_government.people import DEPARTMENT_KEYS, TEAM_GROUPS

_DEPARTMENT_GROUPS = {key: (TEAM_GROUPS[key], "write") for key in DEPARTMENT_KEYS}
_LEADS = {key: f"internal_{key}_lead" for key in DEPARTMENT_KEYS}

PROJECTS = (
    ("Business Permit Renewal Drive", "bplo"),
    ("Rainy Season Drainage Program", "public_works"),
    ("Annual Budget Preparation", "budget_accounting"),
)
PROJECT_GROUPS = (("city-hall-staff", "write"), ("state-auditors", "read"))
POST_STATES = ("draft", "published", "scheduled", "archived")
LAYOUTS = ("table", "grid", "gallery")
REMINDERS = ("start", "15m", "1d")
POSTS_PER_BOARD = 8
EVENTS_PER_BOARD = 12

# Blank attachments on seeded posts (indexes 0-5 stay visible) and events. None sit on the
# control anchor Board (Annual Budget Preparation), whose files the controls add and remove.
BOARD_FILES = tuple(
    BoardFileSpec(f"file:{board}:{kind}:{index}", board, kind, index, filename)
    for board, kind, index, filename in (
        ("department:bplo", "post", 1, "Renewal requirements checklist.pdf"),
        ("department:bplo", "event", 3, "Joint inspection schedule.xlsx"),
        ("department:building_official", "post", 0, "Schedule of building fees.pdf"),
        ("department:public_works", "post", 1, "Canal desilting before and after.jpg"),
        ("department:public_works", "event", 7, "Canal map by barangay.png"),
        ("department:treasury", "post", 0, "Property tax discount notice.docx"),
        ("department:budget_accounting", "post", 2, "Voucher document checklist.docx"),
        ("department:procurement", "post", 0, "Annual procurement plan.xlsx"),
        ("department:city_clerk", "post", 2, "Mass wedding application form.pdf"),
        ("project:bplo:business-permit-renewal-drive", "post", 0, "Window layout.jpeg"),
        ("project:public_works:rainy-season-drainage-program", "event", 0,
         "Program briefing.pptx"),
        ("company", "post", 0, "Saturday window schedule.pdf"),
    )
)  # fmt: skip

# The Public Works department Board's demo Kanban: 5 stages, 3 labels, 12 cards (4 records).
KANBAN = KanbanSpec(
    board="department:public_works",
    stages=(
        ("Reported", "chart-1"),
        ("Scheduled", "chart-2"),
        ("Crew on site", "chart-3"),
        ("Checking", "chart-4"),
        ("Done", "chart-5"),
    ),
    labels=(("Urgent", "chart-1"), ("Drainage", "chart-2"), ("Roads", "chart-3")),
    cards=(
        KanbanCardSpec(0, "Survey the canals of Bagong Silang", labels=(1,), due_in_days=10),
        KanbanCardSpec(0, record="service_requests:000003", labels=(0,), due_in_days=3),
        KanbanCardSpec(1, record="work_orders:000002", labels=(2,), due_in_days=5),
        KanbanCardSpec(1, "Order 200 bags of cold-mix asphalt", labels=(2,), due_in_days=7,
                       checklist=("Ask GSO for the purchase request", "Check the stock count")),
        KanbanCardSpec(1, record="service_requests:000004"),
        KanbanCardSpec(2, record="work_orders:000003", labels=(0,), due_in_days=2),
        KanbanCardSpec(2, "Desilt the Acacia Creek outfall", labels=(1,),
                       description="Coordinate with the barangay before the backhoe arrives.",
                       checklist=("Tell the barangay captain", "Book the backhoe",
                                  "Arrange the dump truck")),
        KanbanCardSpec(2, "Replace the streetlights on Rizal Avenue", due_in_days=6),
        KanbanCardSpec(3, "Check the patched potholes on Molave Street", labels=(2,),
                       due_in_days=4),
        KanbanCardSpec(3, "Inspect the new manhole covers", due_in_days=5),
        KanbanCardSpec(4, "Clear the fallen tree on Narra Street", labels=(0,),
                       checklist=("Haul the branches", "Close the request")),
        KanbanCardSpec(4, "Repaint the pedestrian lanes near the school"),
    ),
)  # fmt: skip


def content_spec() -> ContentSpec:
    """Return the city government's content used by shared Board and OpenView flows."""
    return ContentSpec(
        department_groups=_DEPARTMENT_GROUPS,
        leads=_LEADS,
        projects=PROJECTS,
        project_groups=PROJECT_GROUPS,
        required_modules=(
            ("payment_orders", "treasury"),
            ("official_receipts", "treasury"),
            ("service_requests", "public_works"),
            ("work_orders", "public_works"),
        ),
        company_source_department="treasury",
        required_records={
            "payment_orders:000001": "payment_orders",
            "official_receipts:000001": "official_receipts",
            "service_requests:000001": "service_requests",
            "work_orders:000001": "work_orders",
        },
        amounts=(
            MoneySpec(
                "amount_due", "payment_orders:000001", "Amount due ₱", Decimal(SCENARIO_DUE)
            ),  # fmt: skip
            MoneySpec(
                "receipt_amount", "official_receipts:000001", "Amount ₱", Decimal(SCENARIO_PAID)
            ),  # fmt: skip
        ),
        scenario_total=Decimal(SCENARIO_DUE),
        scenario_paid=Decimal(SCENARIO_PAID),
        scenario_balance=Decimal(SCENARIO_BALANCE),
        board_links=(
            BoardLinkSpec(
                "link:treasury-post",
                "post",
                "department:treasury",
                2,
                ("payment_orders:000001", "official_receipts:000001"),
            ),
            BoardLinkSpec(
                "link:public-works-event",
                "event",
                "department:public_works",
                0,
                ("service_requests:000001", "work_orders:000001"),
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
