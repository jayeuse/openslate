"""Foundation departments, Sandbox modules, relationships, and size profiles."""

from __future__ import annotations

from typing import Literal

from operations.sample.packs.nonprofit.catalog_fundraising import GRANTS, RESOURCE_MOBILIZATION
from operations.sample.packs.nonprofit.catalog_operations import FINANCE, PROCUREMENT, VOLUNTEERS
from operations.sample.packs.nonprofit.catalog_programs import EXECUTIVE, MEAL, PROGRAMS
from operations.sample.packs.types import RelationshipSpec, SampleProfile

Cardinality = Literal["one-to-one", "one-to-many", "many-to-many"]

_DEPARTMENTS = (
    ("resource_mobilization", "Resource Mobilization"),
    ("grants_partnerships", "Grants and Partnerships"),
    ("programs", "Programs"),
    ("meal", "MEAL"),
    ("finance", "Finance"),
    ("procurement", "Procurement and Logistics"),
    ("volunteer_engagement", "Volunteer Engagement"),
    ("executive_office", "Executive Office"),
)

_MODULES = (
    *RESOURCE_MOBILIZATION, *GRANTS, *PROGRAMS, *MEAL, *FINANCE, *PROCUREMENT, *VOLUNTEERS,
    *EXECUTIVE,
)  # fmt: skip


def _link(
    key: str, name: str, source: str, target: str, cardinality: Cardinality = "one-to-many"
) -> RelationshipSpec:
    """A link inside one department: the later (target) record links to its parent."""
    return RelationshipSpec(key, name, source, target, cardinality)


def _names(key: str, name: str, source: str, target: str, cardinality: Cardinality
           ) -> RelationshipSpec:  # fmt: skip
    """A record that names a record kept in another department links itself (rule 11)."""
    return RelationshipSpec(key, name, source, target, cardinality, child="source")


_RELATIONSHIPS = (
    _link("donor_donations", "Donations", "donors", "donations"),
    _link("donor_pledges", "Pledges", "donors", "pledges"),
    _link("campaign_donations", "Donations", "campaigns", "donations"),
    _link("campaign_pledges", "Pledges", "campaigns", "pledges"),
    _link("pledge_donations", "Payments", "pledges", "donations"),
    _link("funder_grants", "Grants", "organizations", "grant_awards"),
    _link("grant_budget_lines", "Budget lines", "grant_awards", "budget_lines"),
    _link("grant_report_schedule", "Reports", "grant_awards", "grant_reports"),
    _link("project_sites", "Sites", "projects", "sites", "many-to-many"),
    _link("project_activities", "Activities", "projects", "activities"),
    _link("site_activities", "Activities", "sites", "activities"),
    _link("site_beneficiaries", "Residents", "sites", "beneficiaries"),
    _link("project_beneficiaries", "Participants", "projects", "beneficiaries", "many-to-many"),
    _link("beneficiary_assistance", "Assistance", "beneficiaries", "assistance"),
    _link("activity_assistance", "Assistance", "activities", "assistance"),
    _link("indicator_result_series", "Results", "indicators", "indicator_results"),
    _link("advance_expenses", "Liquidation", "cash_advances", "expense_lines"),
    _link("advance_release", "Release voucher", "cash_advances", "disbursements", "one-to-one"),
    _link("supplier_orders", "Purchase orders", "suppliers", "purchase_orders"),
    _link("request_orders", "Purchase orders", "purchase_requests", "purchase_orders"),
    # Links to records in another department.
    _names("project_grants", "Funding grants", "projects", "grant_awards", "many-to-many"),
    _names("indicator_project", "Project", "indicators", "projects", "many-to-many"),
    _names("feedback_project", "Project", "feedback_cases", "projects", "many-to-many"),
    _names("fund_grant", "Grant", "funds", "grant_awards", "one-to-one"),
    _names("expense_budget_line", "Budget line", "expense_lines", "budget_lines",
           "many-to-many"),  # fmt: skip
    _names("request_budget_line", "Budget line", "purchase_requests", "budget_lines",
           "many-to-many"),  # fmt: skip
    _names("disbursement_order", "Purchase order", "disbursements", "purchase_orders",
           "many-to-many"),  # fmt: skip
)

_STANDARD_COUNTS = {module.key: module.standard_count for module in _MODULES}
PROFILE_COUNTS: dict[SampleProfile, dict[str, int]] = {
    "small": {key: max(1, (count + 4) // 5) for key, count in _STANDARD_COUNTS.items()},
    "standard": dict(_STANDARD_COUNTS),
    "large": {key: count * 4 for key, count in _STANDARD_COUNTS.items()},
}
SPECIAL_STATUSES: dict[str, dict[int, str]] = {}
