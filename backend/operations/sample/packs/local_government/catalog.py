"""City government departments, Sandbox modules, relationships, and size profiles."""

from __future__ import annotations

from typing import Literal

from operations.sample.packs.local_government.catalog_finance import BUDGET, TREASURY
from operations.sample.packs.local_government.catalog_permits import BUILDING, BUSINESS
from operations.sample.packs.local_government.catalog_procurement import PROCUREMENT
from operations.sample.packs.local_government.catalog_services import CLERK, PUBLIC_WORKS
from operations.sample.packs.types import RelationshipSpec, SampleProfile

Cardinality = Literal["one-to-one", "one-to-many", "many-to-many"]

_DEPARTMENTS = (
    ("bplo", "Business Permits and Licensing"),
    ("building_official", "Building Official"),
    ("public_works", "Engineering and Public Works"),
    ("treasury", "Treasury"),
    ("budget_accounting", "Budget and Accounting"),
    ("procurement", "Procurement and General Services"),
    ("city_clerk", "City Clerk, Records and Council"),
)

_MODULES = (*BUSINESS, *BUILDING, *PUBLIC_WORKS, *TREASURY, *BUDGET, *PROCUREMENT, *CLERK)


def _link(
    key: str, name: str, source: str, target: str, cardinality: Cardinality = "one-to-many"
) -> RelationshipSpec:
    """A link inside one department: the later (target) record links to its parent."""
    return RelationshipSpec(key, name, source, target, cardinality)


def _names(
    key: str, name: str, source: str, target: str, cardinality: Cardinality
) -> RelationshipSpec:
    """The record that names another one links itself once both exist (plan rule 11)."""
    return RelationshipSpec(key, name, source, target, cardinality, child="source")


_RELATIONSHIPS = (
    _link(
        "establishment_applications",
        "Permit applications",
        "business_establishments",
        "permit_applications",
    ),  # fmt: skip
    _link(
        "establishment_inspections",
        "Inspections",
        "business_establishments",
        "business_inspections",
    ),  # fmt: skip
    _link(
        "establishment_notices",
        "Enforcement notices",
        "business_establishments",
        "enforcement_notices",
    ),  # fmt: skip
    _link(
        "inspection_notices", "Enforcement notices", "business_inspections", "enforcement_notices"
    ),  # fmt: skip
    _link("permit_inspections", "Inspections", "building_permits", "building_inspections"),
    _link(
        "request_work_orders", "Work orders", "service_requests", "work_orders", "many-to-many"
    ),  # fmt: skip
    _link("order_receipts", "Official receipts", "payment_orders", "official_receipts"),
    _link(
        "appropriation_obligations", "Obligation requests", "appropriations", "obligation_requests"
    ),  # fmt: skip
    _link(
        "obligation_vouchers",
        "Disbursement vouchers",
        "obligation_requests",
        "disbursement_vouchers",
    ),  # fmt: skip
    _names(
        "project_requests",
        "Purchase requests",
        "procurement_projects",
        "purchase_requests",
        "one-to-many",
    ),  # fmt: skip
    _link("project_bids", "Bids and quotations", "procurement_projects", "bids"),
    _link("supplier_bids", "Bids and quotations", "suppliers", "bids"),
    _link(
        "project_purchase_orders", "Purchase orders", "procurement_projects", "purchase_orders"
    ),  # fmt: skip
    _link("supplier_purchase_orders", "Purchase orders", "suppliers", "purchase_orders"),
    _link(
        "order_acceptance_reports", "Acceptance reports", "purchase_orders", "acceptance_reports"
    ),  # fmt: skip
    _link(
        "measure_communications",
        "Communications",
        "legislative_measures",
        "communications",
        "many-to-many",
    ),  # fmt: skip
    # Links to records kept in another department.
    _names(
        "order_application",
        "Permit application",
        "payment_orders",
        "permit_applications",
        "many-to-many",
    ),  # fmt: skip
    _names(
        "order_building_permit",
        "Building permit",
        "payment_orders",
        "building_permits",
        "many-to-many",
    ),  # fmt: skip
    _names(
        "release_voucher",
        "Disbursement voucher",
        "payment_releases",
        "disbursement_vouchers",
        "one-to-one",
    ),  # fmt: skip
    _names(
        "obligation_purchase_order",
        "Purchase order",
        "obligation_requests",
        "purchase_orders",
        "many-to-many",
    ),  # fmt: skip
    _names(
        "voucher_acceptance_reports",
        "Acceptance reports",
        "disbursement_vouchers",
        "acceptance_reports",
        "one-to-many",
    ),  # fmt: skip
)

_STANDARD_COUNTS = {module.key: module.standard_count for module in _MODULES}
PROFILE_COUNTS: dict[SampleProfile, dict[str, int]] = {
    "small": {key: max(1, (count + 4) // 5) for key, count in _STANDARD_COUNTS.items()},
    "standard": dict(_STANDARD_COUNTS),
    "large": {key: count * 4 for key, count in _STANDARD_COUNTS.items()},
}
SPECIAL_STATUSES: dict[str, dict[int, str]] = {}
