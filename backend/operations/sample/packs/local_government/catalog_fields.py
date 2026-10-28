"""Typed field and module builders plus the city government's option lists."""

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
    default: str | None = None,
    value_kind: str = "choice",
) -> FieldSpec:
    """A Select with a default: the first option unless another is named."""
    selected = default if default is not None else options[0]
    return _field(
        key, name, "Select", value_kind, required=required, options=options, default=selected,
        has_default=True,
    )  # fmt: skip


def _optional_choice(key: str, name: str, options: tuple[str, ...], value_kind: str) -> FieldSpec:
    """A Select that stays empty until it applies (an evaluation, a routing office)."""
    return _field(key, name, "Select", value_kind, options=options)


def _flag(key: str, name: str) -> FieldSpec:
    """A follow-up flag that a Set-field rule turns on; people leave it off."""
    return _field(key, name, "Checkbox", "flag", default=False, has_default=True)


def _check(key: str, name: str) -> FieldSpec:
    return _field(key, name, "Checkbox", "boolean", default=False, has_default=True)


def _peso(key: str, name: str, value_kind: str, *, required: bool = False) -> FieldSpec:
    return _field(key, name, "Number", value_kind, required=required, minimum=0, step=0.01)


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


BARANGAYS = (
    "Poblacion", "San Roque", "Bagong Silang", "Mabini", "Santo Niño", "Malinis", "Kaunlaran",
    "Bagumbayan", "San Jose", "Riverside", "Maligaya", "Pag-asa",
)  # fmt: skip
OFFICES = (
    "Office of the City Mayor", "City Engineering Office", "Business Permits and Licensing",
    "Office of the Building Official", "City Treasurer's Office", "City Budget Office",
    "City Accounting Office", "General Services Office", "Sangguniang Panlungsod",
    "City Civil Registry", "City Health Office", "City Disaster Risk Reduction Office",
)  # fmt: skip
LINES_OF_BUSINESS = (
    "Sari-sari and convenience store", "Carinderia or eatery", "Bakery",
    "Hardware and construction supply", "Pharmacy", "Water refilling station", "Laundry shop",
    "Barbershop or salon", "Auto repair shop", "Rice retailer", "Printing and internet shop",
    "Boarding house", "Medical clinic", "Private school", "Pawnshop or lending",
    "Gasoline station", "Warehouse", "General contractor", "Space lessor",
    "Professional services",
)  # fmt: skip
ORG_TYPES = ("Sole proprietorship", "Corporation", "Partnership", "One-person corporation",
             "Cooperative")  # fmt: skip
APPLICATION_TYPES = ("Renewal", "New", "Amendment", "Retirement", "Special permit")
SLA_FLAGS = ("On time", "At risk", "Breached")
BUSINESS_INSPECTION_TYPES = ("Post-issuance joint inspection", "Complaint-based",
                             "Re-inspection", "Closure verification")  # fmt: skip
NOTICE_TYPES = ("Notice of violation", "Notice of delinquency", "Cease and desist",
                "Closure order", "Lifting order")  # fmt: skip
VIOLATIONS = ("No permit", "Expired permit", "Unpaid tax", "No sanitary permit",
              "Fire safety deficiency", "Zoning nonconformity", "Unpermitted signage")  # fmt: skip
SCOPES = ("New construction", "Addition", "Alteration", "Renovation", "Repair", "Demolition",
          "Legalization", "Fencing", "Signage")  # fmt: skip
COMPLEXITY = ("Simple", "Complex", "Highly technical")
BUILDING_INSPECTION_TYPES = (
    "Pre-permit site", "Excavation and foundation", "Structural framing", "Electrical rough-in",
    "Plumbing rough-in", "Final", "Illegal-construction complaint",
)  # fmt: skip
SERVICE_TYPES = (
    "Clogged drainage or canal", "Pothole", "Streetlight out", "Uncollected garbage",
    "Street flooding", "Fallen tree or branch", "Streetlight flickering", "Damaged sidewalk",
    "Illegal dumping", "Open or missing manhole cover", "Damaged road sign", "Road obstruction",
    "Illegal construction report", "Stray animals", "Leaking water main", "Graffiti",
)  # fmt: skip
CHANNELS = ("Hotline", "Walk-in", "Online form", "Social media", "Barangay referral",
            "Staff-observed")  # fmt: skip
PRIORITIES = ("Normal", "Low", "High", "Emergency")
WORK_TYPES = (
    "Pothole patching", "Declogging and desilting", "Streetlight repair", "Tree trimming",
    "Sidewalk repair", "Manhole cover replacement", "Special garbage pickup", "Sign repair",
)  # fmt: skip
CREWS = ("Crew 1", "Crew 2", "Crew 3", "Crew 4", "Electrical team", "Motorpool")
OOP_SOURCES = ("Business permit", "Building permit", "Occupancy", "Civil registry",
               "Real property tax", "Other")  # fmt: skip
RECEIPT_MODES = ("Cash", "Check", "Online or e-wallet", "Bank deposit")
RECEIPT_NATURES = (
    "Business tax", "Regulatory fee", "Building and ancillary fees", "RPT basic", "RPT SEF",
    "Civil registry fee", "Surcharge and interest", "Other",
)  # fmt: skip
RELEASE_MODES = ("Check", "ADA direct credit", "Disbursing officer cash")
EXPENSE_CLASSES = ("MOOE", "Personal services", "Capital outlay", "Financial expenses")
FUND_SOURCES = ("Annual", "Supplemental No. 1", "Supplemental No. 2", "Continuing")
FUNDS = ("General Fund", "Special Education Fund", "Trust Fund", "20% Development Fund")
SUPPLIER_TYPES = ("Goods", "Infrastructure contractor", "Service provider", "Consulting")
PROCUREMENT_MODES = (
    "Small value procurement", "Competitive bidding", "Direct acquisition",
    "Limited source bidding", "Direct contracting", "Repeat order",
    "Negotiated after two failed biddings", "Negotiated emergency", "Direct sales",
)  # fmt: skip
TIMELINE_FLAGS = ("On track", "At risk", "Over 60-day cap")
EVALUATIONS = (
    "Responsive", "Lowest calculated responsive bid", "Pending", "Lowest calculated",
    "Non-responsive", "Post-disqualified",
)  # fmt: skip
DOCUMENT_TYPES = (
    "Letter-request", "Memorandum", "Endorsement", "Transmittal", "Invitation", "Complaint",
    "Executive order", "Office order", "Travel order", "Certification",
    "Barangay resolution", "FOI request", "Audit observation memorandum",
    "Memorandum circular", "Position paper", "Subpoena",
)  # fmt: skip
ACTIONS_REQUIRED = ("For information", "For appropriate action", "For comment",
                    "For signature", "For compliance", "FOI request")  # fmt: skip
MEASURE_KINDS = ("Resolution", "Ordinance", "Appropriation ordinance", "Revenue ordinance")
COMMITTEES = (
    "Rules and Privileges", "Ways and Means", "Appropriations", "Public Works",
    "Trade and Industry", "Health and Sanitation", "Environment", "Peace and Order",
    "Education", "Women and Family", "Transportation",
)  # fmt: skip
CIVIL_EVENTS = ("Birth", "Death", "Marriage", "Marriage license application")
