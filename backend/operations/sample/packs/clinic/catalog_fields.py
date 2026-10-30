"""Typed field and module builders plus the clinic's option lists."""

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
    """A Select that stays empty until it applies (a cancel reason, a denial code)."""
    return _field(key, name, "Select", value_kind, options=options)


def _flag(key: str, name: str) -> FieldSpec:
    """A follow-up flag that a Set-field rule turns on; people leave it off."""
    return _field(key, name, "Checkbox", "flag", default=False, has_default=True)


def _check(key: str, name: str) -> FieldSpec:
    return _field(key, name, "Checkbox", "boolean", default=False, has_default=True)


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


PAYER_CLASSES = ("Commercial insurance", "Medicare", "Medicaid", "Employer account", "Self-pay")
VISIT_TYPES = (
    "Follow-up", "Acute same-day", "New patient", "Chronic disease review", "Annual physical",
    "Well-child", "Vaccination", "Results review", "Telehealth follow-up", "Prenatal",
    "Pre-employment physical", "Minor procedure", "Specialist consult", "Lab-only visit",
)  # fmt: skip
EM_CODES = (
    "99213", "99214", "99212", "99203", "99215", "99204", "99202", "99211", "99205",
)  # fmt: skip
DISPOSITIONS = ("Home", "Follow-up booked", "Referred", "Sent to ED")
ORDER_CATEGORIES = ("Laboratory", "Imaging", "Procedure")
PRIORITIES = ("Routine", "Urgent", "ASAP", "STAT")
PERFORMERS = ("In-house lab", "Reference lab", "Outside imaging")
SPECIMEN_TYPES = (
    "Whole blood (EDTA)", "Serum", "Urine", "Plasma", "Throat swab", "Nasopharyngeal swab",
    "Stool", "Sputum",
)  # fmt: skip
REJECTION_REASONS = (
    "Hemolyzed", "Clotted", "Quantity not sufficient", "Unlabeled or mislabeled", "Wrong tube",
    "Delayed transport",
)  # fmt: skip
RESULT_FLAGS = ("Normal", "High", "Low", "Abnormal", "Critical high", "Critical low")
QC_RULES = ("None", "1-2s warning", "1-3s", "2-2s", "R-4s", "10x")
DOSAGE_FORMS = (
    "Tablet", "Capsule", "Syrup", "Suspension", "Inhaler", "Cream or ointment", "Injection",
    "Sachet", "Prefilled syringe",
)  # fmt: skip
LOT_LOCATIONS = ("Dispensary shelf", "Vaccine fridge 1", "Pharmacy fridge 2", "Stockroom")
EXPIRY_BANDS = ("More than 6 months", "3 to 6 months", "Under 3 months", "Expired")
CREDENTIAL_BANDS = ("More than 90 days", "31 to 90 days", "30 days or less", "Expired")
CARC_CODES = (
    "CO-45 Charge exceeds fee schedule", "PR-1 Deductible", "PR-2 Coinsurance",
    "PR-3 Copayment", "CO-16 Claim lacks information", "CO-197 Authorization missing",
    "CO-50 Not medically necessary", "CO-97 Included in another service",
    "CO-27 Coverage ended", "CO-29 Filing limit expired", "CO-31 Patient not identified",
    "CO-18 Duplicate claim", "CO-22 Another payer may cover", "CO-109 Wrong payer",
    "CO-167 Diagnosis not covered", "CO-204 Not covered by plan", "CO-252 Attachment required",
)  # fmt: skip
INCIDENT_TYPES = (
    "Patient accident", "Clinical process", "Documentation", "Medication", "Medical device",
    "Cold chain", "Behavior", "Staff injury", "Privacy breach", "Infrastructure",
    "Healthcare-associated infection", "Clinical administration",
)  # fmt: skip
HARM_LEVELS = ("No harm", "Near miss", "Mild", "Moderate", "Severe", "Death")
CREDENTIAL_TYPES = (
    "Medical license", "Nursing license", "Pharmacist license", "Lab scientist license",
    "DEA registration", "BLS certification", "ACLS certification", "Board certification",
    "Malpractice insurance", "Payer enrollment",
)  # fmt: skip
