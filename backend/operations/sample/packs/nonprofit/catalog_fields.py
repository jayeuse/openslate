"""Typed field and module builders plus the foundation's option lists."""

from __future__ import annotations

from operations.sample.packs.types import FieldSpec, FieldType, JsonValue, ModuleSpec


def _field(
    key: str,
    name: str,
    type_: FieldType,
    value_kind: str,
    *,
    required: bool = False,
    options: tuple[str, ...] = (),
    default: JsonValue = None,
    has_default: bool = False,
    minimum: int | float | None = None,
    maximum: int | float | None = None,
    step: int | float | None = None,
) -> FieldSpec:
    return FieldSpec(
        key, name, type_, value_kind, required, options, default, has_default, minimum, maximum,
        step,
    )  # fmt: skip


def _choice(
    key: str,
    name: str,
    options: tuple[str, ...],
    *,
    required: bool = False,
    value_kind: str = "choice",
) -> FieldSpec:
    """A Select with the first option as its default."""
    return _field(
        key, name, "Select", value_kind, required=required, options=options, default=options[0],
        has_default=True,
    )  # fmt: skip


def _optional_choice(key: str, name: str, options: tuple[str, ...], value_kind: str) -> FieldSpec:
    """A Select that stays empty until it applies."""
    return _field(key, name, "Select", value_kind, options=options)


def _flag(key: str, name: str) -> FieldSpec:
    """A follow-up flag that a Set-field rule turns on; people leave it off."""
    return _field(key, name, "Checkbox", "flag", default=False, has_default=True)


def _check(key: str, name: str) -> FieldSpec:
    return _field(key, name, "Checkbox", "boolean", default=False, has_default=True)


def _peso(key: str, name: str, kind: str, *, required: bool = False) -> FieldSpec:
    return _field(key, name, "Number", kind, required=required, minimum=0)


def _module(
    key: str,
    name: str,
    department: str,
    prefix: str,
    date_name: str,
    statuses: tuple[str, ...],
    standard_count: int,
    fields: tuple[FieldSpec, ...],
) -> ModuleSpec:
    common = (
        _field("name", "Name", "Text", "title", required=True),
        _choice("status", "Status", statuses, required=True, value_kind="status"),
        _field("owner", "Assigned to", "User", "owner"),
        _field("notes", "Notes", "Long text", "notes", default="", has_default=True),
    )
    return ModuleSpec(
        key, name, department, prefix, date_name, statuses, standard_count, (*common, *fields)
    )


AWARDED = "Awarded – contracting"
GRANT_STAGES = (
    "Identified", "Concept note submitted", "Proposal submitted", "Under donor review", AWARDED,
    "Active", "Closing", "Closed", "Declined", "Withdrawn", "Suspended", "Terminated",
)  # fmt: skip
PAYMENT_METHODS = (
    "Bank transfer", "Mobile wallet", "Card", "Online platform", "Check", "Cash",
    "Payroll giving",
)  # fmt: skip
GIFT_TYPES = ("One-time", "Recurring installment", "Pledge payment", "In-kind", "Matching gift")
RESTRICTIONS = (
    "Unrestricted", "Restricted – project", "Restricted – emergency appeal", "Restricted – time",
)  # fmt: skip
ACKNOWLEDGEMENTS = (
    "To be acknowledged", "Acknowledged", "Email acknowledgement not sent", "Do not acknowledge",
)  # fmt: skip
CAMPAIGN_TYPES = (
    "Year-end appeal", "Emergency appeal", "Monthly giving drive", "Event",
    "Corporate partnership", "Peer-to-peer", "Major gifts",
)  # fmt: skip
ORG_TYPES = (
    "Foundation", "Corporate", "Bilateral or multilateral donor", "Government agency",
    "Local implementing partner", "Community association",
)  # fmt: skip
ORG_ROLES = ("Funder", "Corporate partner", "Implementing partner", "Coordination")
COST_CATEGORIES = (
    "Personnel", "Fringe", "Travel", "Equipment", "Supplies", "Contractual", "Other direct",
    "Indirect",
)  # fmt: skip
REPORT_TYPES = (
    "Interim narrative", "Interim financial", "Annual work plan", "Final narrative",
    "Final financial", "Audit report", "Inventory disposition",
)  # fmt: skip
PROGRAM_AREAS = ("Livelihood", "Education support", "Disaster response", "DRR and preparedness")
SITE_TYPES = ("Community", "School", "Evacuation center", "Market", "Warehouse")
HAZARDS = ("Storm surge", "Riverine flood", "Landslide", "Coastal flood", "Low")
ACTIVITY_TYPES = (
    "Training", "Community meeting", "Distribution", "Tutoring session", "Assessment",
    "Monitoring visit", "Coordination meeting", "Drill",
)  # fmt: skip
VULNERABILITIES = (
    "None recorded", "Female-headed household", "Person with disability", "Older person",
    "Pregnant or lactating",
)  # fmt: skip
ASSISTANCE_TYPES = (
    "Food pack", "Hygiene kit", "Shelter repair kit", "Sleeping kit", "Kitchen set",
    "Water filter", "Solar lamp", "Multipurpose cash – tranche 1", "Multipurpose cash – tranche 2",
    "School kit", "Seeds and tools pack", "Fishing gear pack", "Dignity kit", "Starter kit",
    "Seed capital grant", "Skills training certificate", "Tuition subsidy", "Tutoring package",
    "Psychosocial session", "Referral",
)  # fmt: skip
CHANNELS = (
    "Hotline", "SMS", "Help desk", "Suggestion box", "Community meeting", "Face-to-face",
)  # fmt: skip
FEEDBACK_CATEGORIES = (
    "Assistance request", "Information request", "Exclusion complaint",
    "Quality or quantity complaint", "Appreciation", "Staff or volunteer conduct",
    "Safeguarding/PSEA", "Fraud or diversion",
)  # fmt: skip
SAFEGUARDING = "Safeguarding/PSEA"
SENSITIVITIES = ("Standard", "Sensitive", "Restricted – safeguarding")
PRIORITIES = ("Medium", "Low", "High", "Critical")
RESTRICTION_CLASSES = (
    "With donor restrictions – purpose", "Without donor restrictions",
    "With donor restrictions – time", "Perpetual",
)  # fmt: skip
EXPENSE_CATEGORIES = (
    "Participant meals and snacks", "Venue rental", "Fuel and boat hire", "Training materials",
    "Facilitator honoraria", "Mobile load", "Printing", "Accommodation", "Per diem",
    "Trucking and hauling", "Warehouse rental", "Bank charges", "Audit fees", "Office supplies",
)  # fmt: skip
RECEIPT_TYPES = (
    "Official receipt", "Sales invoice", "Acknowledgement receipt", "Certified no-receipt",
)  # fmt: skip
DISBURSEMENT_TYPES = (
    "Advance release", "Supplier payment", "Reimbursement", "Partner tranche", "Payroll",
    "Donor refund",
)  # fmt: skip
SUPPLIER_CATEGORIES = (
    "Food and NFI", "Construction materials", "Printing", "Trucking", "Catering and venue",
    "IT equipment", "Consultants",
)  # fmt: skip
PROCUREMENT_METHODS = (
    "Micro-purchase", "RFQ – 3 quotes", "Competitive negotiated", "Open tender",
    "Single source – justified",
)  # fmt: skip
DELIVERY_SITES = ("Main warehouse", "North field office", "South field office", "Direct to site")
SKILLS = (
    "Repacking", "Tutoring", "First aid", "Data encoding", "Driving", "Photography", "Counseling",
)  # fmt: skip
