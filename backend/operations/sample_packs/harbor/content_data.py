"""Harbor Board plans, named settlement records, and access data."""

from decimal import Decimal

from operations.sample_packs.content_types import BoardLinkSpec, ContentSpec, MoneySpec
from operations.sample_packs.harbor import content_text as text

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

_LAYOUTS = ("table", "grid", "kanban", "calendar", "timeline", "gallery")

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
    )
