"""Distributor Board plans, the invoice part-payment, and OpenView content data."""

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
from operations.sample.packs.fmcg_distributor import content_text as text
from operations.sample.packs.fmcg_distributor.ledger import (
    SCENARIO_BALANCE,
    SCENARIO_INVOICE,
    SCENARIO_PAYMENT,
)
from operations.sample.packs.fmcg_distributor.people import DEPARTMENT_KEYS, TEAM_GROUPS

_DEPARTMENT_GROUPS = {key: (TEAM_GROUPS[key], "write") for key in DEPARTMENT_KEYS}
_LEADS = {key: f"internal_{key}_lead" for key in DEPARTMENT_KEYS}

PROJECTS = (
    ("Christmas Order Drive", "sales"),
    ("Quarter-End Stock Take", "warehouse"),
    ("Principal Claims Recovery", "accounting"),
)

_POST_STATES = ("draft", "published", "scheduled", "archived")
_LAYOUTS = ("table", "grid", "gallery")
_REMINDERS = ("start", "15m", "1d")

# Blank attachments on seeded posts (indexes 0-5 stay visible) and events. None sit on the
# control anchor Board (Principal Claims Recovery), whose files the controls add and remove.
_BOARD_FILES = tuple(
    BoardFileSpec(f"file:{board}:{kind}:{index}", board, kind, index, filename)
    for board, kind, index, filename in (
        ("department:sales", "post", 1, "PJP beat changes.xlsx"),
        ("department:trade_marketing", "post", 0, "Kestrel Q4 scheme circular.pdf"),
        ("department:trade_marketing", "post", 1, "Display audit photo.jpg"),
        ("department:purchasing", "post", 0, "Kestrel price list.xlsx"),
        ("department:warehouse", "post", 0, "Near-expiry list.pdf"),
        ("department:warehouse", "event", 4, "Bin map.png"),
        ("department:logistics", "post", 0, "Truck PMS schedule.docx"),
        ("department:credit_collections", "post", 4, "PDC register.xlsx"),
        ("department:accounting", "post", 0, "Claim deadlines by principal.pdf"),
        ("project:sales:christmas-order-drive", "post", 5, "Gift pack display.jpeg"),
        ("project:warehouse:quarter-end-stock-take", "event", 0, "Count teams briefing.pptx"),
        ("company", "post", 2, "All-hands results.pptx"),
    )
)

# The Warehouse department Board's demo Kanban: 5 stages, 3 labels, 12 cards (4 records).
KANBAN = KanbanSpec(
    board="department:warehouse",
    stages=(
        ("To count", "chart-1"),
        ("Counting", "chart-2"),
        ("Variance check", "chart-3"),
        ("Adjusted", "chart-4"),
        ("Done", "chart-5"),
    ),
    labels=(("Urgent", "chart-1"), ("A items", "chart-2"), ("BO cage", "chart-3")),
    cards=(
        KanbanCardSpec(0, "Count the A items in aisle C", labels=(1,), due_in_days=3),
        KanbanCardSpec(0, "Publish this week's near-expiry list", labels=(0,), due_in_days=1),
        KanbanCardSpec(1, record="stock_counts:000002", labels=(1,), due_in_days=2),
        KanbanCardSpec(1, "Plan the quarter-end stock take", labels=(0,), due_in_days=14,
                       checklist=("Book the count teams", "Print the count sheets by bin")),
        KanbanCardSpec(1, record="stock_counts:000003"),
        KanbanCardSpec(2, record="stock_adjustments:000002", labels=(0,), due_in_days=2),
        KanbanCardSpec(2, "Sort the BO cage by principal", labels=(2,),
                       description="Claims cut-off is on the 25th; photos go with each claim.",
                       checklist=("Separate expired and damaged", "Photograph each pallet",
                                  "Send the list to the claims officer")),
        KanbanCardSpec(2, "Re-wrap the damaged pallets on bay 2", due_in_days=4),
        KanbanCardSpec(3, record="returns:000002", labels=(2,), due_in_days=5),
        KanbanCardSpec(3, "Move the cold room lots to FEFO bins", labels=(1,), due_in_days=6),
        KanbanCardSpec(4, "Pest control visit", labels=(0,),
                       checklist=("Cover the open pallets", "File the treatment report")),
        KanbanCardSpec(4, "Safety toolbox talk on stacking heights"),
    ),
)  # fmt: skip


def content_spec() -> ContentSpec:
    """Return distributor-specific content used by shared Board and OpenView flows."""
    return ContentSpec(
        department_groups=_DEPARTMENT_GROUPS,
        leads=_LEADS,
        projects=PROJECTS,
        project_groups=(("distributor-staff", "write"), ("principal-reps", "read")),
        required_modules=(
            ("sales_invoices", "credit_collections"),
            ("collection_receipts", "credit_collections"),
            ("sales_orders", "sales"),
            ("store_visits", "sales"),
        ),
        company_source_department="credit_collections",
        required_records={
            "sales_invoices:000001": "sales_invoices",
            "collection_receipts:000001": "collection_receipts",
            "sales_orders:000001": "sales_orders",
            "store_visits:000001": "store_visits",
        },
        amounts=(
            MoneySpec("invoice_amount", "sales_invoices:000001", "Amount ₱",
                      Decimal(SCENARIO_INVOICE)),  # fmt: skip
            MoneySpec("payment_amount", "collection_receipts:000001", "Amount ₱",
                      Decimal(SCENARIO_PAYMENT)),  # fmt: skip
        ),
        scenario_total=Decimal(SCENARIO_INVOICE),
        scenario_paid=Decimal(SCENARIO_PAYMENT),
        scenario_balance=Decimal(SCENARIO_BALANCE),
        board_links=(
            BoardLinkSpec(
                "link:credit-post",
                "post",
                "department:credit_collections",
                2,
                ("sales_invoices:000001", "collection_receipts:000001"),
            ),
            BoardLinkSpec(
                "link:sales-event",
                "event",
                "department:sales",
                0,
                ("sales_orders:000001", "store_visits:000001"),
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
        kanban=KANBAN,
    )
