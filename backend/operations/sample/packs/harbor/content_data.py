"""Harbor Board plans, named settlement records, and access data."""

from decimal import Decimal

from operations.sample.packs.content_types import (
    BoardFileSpec,
    BoardLinkSpec,
    ContentSpec,
    KanbanCardSpec,
    KanbanSpec,
    MoneySpec,
)
from operations.sample.packs.harbor import content_text as text

_DEPARTMENT_GROUPS = {
    "sales": ("sales-desk", "manage"),
    "service": ("service-triage", "manage"),
    "field": ("field-operations", "write"),
    "inventory": ("inventory-control", "write"),
    "purchasing": ("purchasing-review", "write"),
    "finance": ("finance-review", "write"),
}

_DEPARTMENT_KEYS = ("sales", "service", "field", "inventory", "purchasing", "finance")

_PROJECTS = (
    ("Customer Renewal", "sales"),
    ("Service Recovery", "service"),
    ("Fleet Reliability", "field"),
    ("Inventory Resilience", "inventory"),
    ("Month-end Close", "finance"),
)

_LAYOUTS = ("table", "grid", "gallery")

_EVENT_TITLES = (
    "Customer account review",
    "Service response checkpoint",
    "Equipment inspection window",
    "Inventory replenishment review",
    "Supplier delivery coordination",
    "Finance close preparation",
    "Regional operations handoff",
    "Quality follow-up",
    "Weekly capacity review",
    "Customer commitment check",
    "Maintenance planning session",
    "Department metrics review",
)

_POST_STATES = ("draft", "published", "scheduled", "archived")

_REMINDERS = ("start", "15m", "1d")

_LEADS = {key: f"internal_{key}_lead" for key in _DEPARTMENT_KEYS}

# Blank attachments on seeded posts (indexes 0-5 stay visible) and events. None sit on
# the control anchor Board (Fleet Reliability), whose files the controls add and remove.
_BOARD_FILES = tuple(
    BoardFileSpec(f"file:{board}:{kind}:{index}", board, kind, index, filename)
    for board, kind, index, filename in (
        ("department:field", "post", 0, "Dock 3 loading plan.pdf"),
        ("department:field", "event", 3, "Pallet damage photo.jpeg"),
        ("department:inventory", "post", 2, "Forklift inspection checklist.xlsx"),
        ("department:inventory", "event", 1, "Yard layout.png"),
        ("department:service", "post", 4, "Service van route map.jpg"),
        ("department:sales", "event", 0, "Customer renewal pricing.pptx"),
        ("department:purchasing", "post", 0, "Supplier delivery schedule.docx"),
        ("department:finance", "post", 2, "Month-end close checklist.xlsx"),
        ("project:sales:customer-renewal", "post", 2, "Renewal terms summary.docx"),
        ("project:inventory:inventory-resilience", "event", 2, "Safety stock review.pptx"),
        ("company", "post", 1, "Quarterly operations update.pdf"),
    )
)

# The Sales department Board's demo Kanban: 5 stages, 3 labels, 12 cards (4 record cards).
_KANBAN = KanbanSpec(
    board="department:sales",
    stages=(
        ("Leads", "chart-1"),
        ("Qualified", "chart-2"),
        ("Quoted", "chart-3"),
        ("Negotiating", "chart-4"),
        ("Won", "chart-5"),
    ),
    labels=(("Priority", "chart-1"), ("Renewal", "chart-2"), ("New account", "chart-3")),
    cards=(
        KanbanCardSpec(0, "Call the cold-storage co-op", labels=(2,), due_in_days=3),
        KanbanCardSpec(0, "Follow up on the trade show list", due_in_days=6),
        KanbanCardSpec(0, record="customers:000003", labels=(2,)),
        KanbanCardSpec(1, "Confirm fleet size with the port authority", labels=(0,),
                       due_in_days=2,
                       checklist=("Ask for the vessel list", "Check crane access")),
        KanbanCardSpec(1, record="customers:000001", labels=(1,), due_in_days=9),
        KanbanCardSpec(2, record="quotes:000001", labels=(0,), due_in_days=4),
        KanbanCardSpec(2, "Price the winter maintenance bundle", labels=(1,),
                       description="Bundle the inspection visits with spare parts.",
                       checklist=("Collect last year's visits", "Draft the price",
                                  "Review with Finance")),
        KanbanCardSpec(3, record="quotes:000002", labels=(0, 1), due_in_days=7),
        KanbanCardSpec(3, "Agree payment terms with the fisheries group", due_in_days=12),
        KanbanCardSpec(4, "Hand over the renewal to Service", labels=(1,),
                       checklist=("Send the signed terms", "Book the kickoff call")),
        KanbanCardSpec(4, "Log the new account in Finance", labels=(2,)),
        KanbanCardSpec(4, "Thank the referral partner"),
    ),
)


def content_spec() -> ContentSpec:
    return ContentSpec(
        department_groups=_DEPARTMENT_GROUPS,
        leads=_LEADS,
        projects=_PROJECTS,
        project_groups=(("harbor-operations", "write"), ("guest-readers", "read")),
        required_modules=(
            ("invoices", "finance"),
            ("payments", "finance"),
            ("equipment", "field"),
            ("work_orders", "field"),
        ),
        company_source_department="finance",
        required_records={
            "invoices:000001": "invoices",
            "payments:000001": "payments",
            "equipment:000001": "equipment",
            "work_orders:000001": "work_orders",
        },
        amounts=(
            MoneySpec("invoice_total", "invoices:000001", "Total", Decimal(12_000)),
            MoneySpec("paid", "payments:000001", "Amount", Decimal(4_500)),
        ),
        scenario_total=Decimal(12_000),
        scenario_paid=Decimal(4_500),
        scenario_balance=Decimal(7_500),
        board_links=(
            BoardLinkSpec(
                "link:finance-post",
                "post",
                "department:finance",
                0,
                ("invoices:000001", "payments:000001"),
            ),
            BoardLinkSpec(
                "link:field-event",
                "event",
                "department:field",
                0,
                ("equipment:000001", "work_orders:000001"),
            ),
        ),
        board_files=_BOARD_FILES,
        post_states=_POST_STATES,
        posts_per_board=8,
        events_per_board=12,
        event_titles=_EVENT_TITLES,
        event_details=text.EVENT_DETAILS,
        event_locations=text.EVENT_LOCATIONS,
        reminders=_REMINDERS,
        layouts=_LAYOUTS,
        posts=text.POSTS,
        board_descriptions=text._BOARD_DESCRIPTIONS,
        layout_names=text._LAYOUT_NAMES,
        post_text=text.post_text,
        revised_post=text.revised_post,
        project_board=text.project_board,
        view_name=text.view_name,
        dashboard_name=text.dashboard_name,
        report_names=text.report_names,
        kanban=_KANBAN,
    )
