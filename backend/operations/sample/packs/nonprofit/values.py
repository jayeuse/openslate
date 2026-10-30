"""Foundation choice labels: each option follows the record's links, status and amounts."""

from __future__ import annotations

from collections.abc import Callable, Mapping

from operations.sample.packs.nonprofit import ledger, links, text, vocabulary
from operations.sample.packs.nonprofit import links_finance as finance
from operations.sample.packs.nonprofit.catalog_fields import SAFEGUARDING
from operations.sample.packs.nonprofit.links import PINNED, rng
from operations.sample.packs.types import FieldSpec, ModuleSpec
from operations.sample.realism import ordered_skew, weighted_label

_AREA_ASSISTANCE = {
    "Disaster response": {"Food pack": 30, "Hygiene kit": 18, "Multipurpose cash – tranche 1": 14,
                          "Shelter repair kit": 9, "Multipurpose cash – tranche 2": 8,
                          "Sleeping kit": 6, "Kitchen set": 5, "Dignity kit": 4,
                          "Water filter": 3, "Solar lamp": 2, "Psychosocial session": 1},
    "Livelihood": {"Starter kit": 30, "Skills training certificate": 25, "Seed capital grant": 20,
                   "Fishing gear pack": 12, "Seeds and tools pack": 10, "Referral": 3},
    "Education support": {"School kit": 40, "Tutoring package": 30, "Tuition subsidy": 22,
                          "Psychosocial session": 5, "Referral": 3},
    "DRR and preparedness": {"Hygiene kit": 35, "Solar lamp": 25, "Water filter": 20,
                             "Skills training certificate": 20},
}  # fmt: skip


def _weighted(module: str, index: int, field: str, weights: Mapping[str, float]) -> str:
    return weighted_label(rng(module, index, field, "choice"), weights)


def project_area(project: int) -> str:
    return vocabulary.PROJECTS[project % len(vocabulary.PROJECTS)][2]


def assistance_type(item: int, counts: Mapping[str, int]) -> str:
    area = project_area(links.assistance_project(item, counts))
    return _weighted("assistance", item, "type", _AREA_ASSISTANCE[area])


def feedback_category(case: int) -> str:
    if case == 0:
        return "Quality or quantity complaint"
    if case == 1:
        return SAFEGUARDING
    weights = {"Assistance request": 25, "Information request": 22, "Exclusion complaint": 15,
               "Appreciation": 15, "Quality or quantity complaint": 12,
               "Staff or volunteer conduct": 5, SAFEGUARDING: 4, "Fraud or diversion": 2}
    return _weighted("feedback_cases", case, "category", weights)


def org_type(organization: int) -> str:
    if organization < len(vocabulary.FUNDERS):
        return vocabulary.FUNDERS[organization][1]
    role = links.org_role(organization)
    if role == "Implementing partner":
        return ("Local implementing partner", "Community association")[organization % 2]
    return {"Coordination": "Government agency", "Funder": "Foundation"}.get(role, "Corporate")


def procurement_method(request: int) -> str:
    estimate = ledger.request_estimate(request)
    if request >= PINNED and request % 23 == 5:
        return "Single source – justified"
    if estimate < 50_000:
        return "Micro-purchase"
    if estimate < 1_000_000:
        return "RFQ – 3 quotes" if request % 4 else "Competitive negotiated"
    return "Open tender"


def disbursement_type(voucher: int, counts: Mapping[str, int]) -> str:
    kind = finance.disbursement_kind(voucher, counts)[0]
    if kind == "advance":
        return "Advance release"
    if kind == "order":
        return "Supplier payment"
    return _weighted("disbursements", voucher, "type", {"Reimbursement": 35, "Payroll": 30,
                                                        "Partner tranche": 25,
                                                        "Donor refund": 10})  # fmt: skip


def choice_label(
    module: ModuleSpec, field: FieldSpec, index: int, counts: Mapping[str, int], status: str
) -> str | None:
    """The option a person picks; ``None`` leaves an optional Select empty."""
    key, name = module.key, field.key
    picked = _PICKERS.get((key, name))
    if picked is not None:
        return picked(index, counts, status)
    if index < PINNED:
        return field.options[index % len(field.options)] if name != "contact_preference" \
            else field.options[0]  # fmt: skip
    return _weighted(key, index, name, ordered_skew(field.options))


def acknowledgement(index: int, _counts: Mapping[str, int], status: str) -> str:
    if status == "Pending":
        return "To be acknowledged"
    if status in {"Failed", "Refunded", "Cancelled"}:
        return "Do not acknowledge"
    return _weighted("donations", index, "ack", {"Acknowledged": 90, "To be acknowledged": 6,
                                                 "Email acknowledgement not sent": 2,
                                                 "Do not acknowledge": 2})  # fmt: skip


def _payment_method(index: int, counts: Mapping[str, int], _status: str) -> str:
    kind = ledger.gift_type(index, counts)
    if kind == "Pledge payment":
        return ("Bank transfer", "Bank transfer", "Check")[index % 3]
    if kind == "Recurring installment":
        return _weighted("donations", index, "method", {"Card": 50, "Mobile wallet": 30,
                                                        "Payroll giving": 20})  # fmt: skip
    return _weighted("donations", index, "method", {
        "Mobile wallet": 30, "Bank transfer": 25, "Online platform": 18, "Card": 12, "Cash": 8,
        "Check": 5, "Payroll giving": 2})  # fmt: skip


def _restriction(index: int, counts: Mapping[str, int], _status: str) -> str:
    campaign = links.donation_campaign(index, counts)
    if campaign is not None:
        kind = vocabulary.CAMPAIGNS[campaign % len(vocabulary.CAMPAIGNS)][1]
        if kind == "Emergency appeal":
            return "Restricted – emergency appeal"
    if ledger.gift_type(index, counts) == "Pledge payment":
        return "Restricted – project" if index % 5 < 3 else "Unrestricted"
    return _weighted("donations", index, "restriction", {"Unrestricted": 85,
                                                         "Restricted – project": 10,
                                                         "Restricted – time": 5})  # fmt: skip


def _due_diligence(index: int, _counts: Mapping[str, int], status: str) -> str:
    if status == "Inactive":
        return "Expired"
    if status == "Prospect":
        return ("Not started", "In review")[index % 2]
    return _weighted("organizations", index, "diligence", {"Cleared": 85, "Expired": 10,
                                                           "In review": 5})  # fmt: skip


def _indicator_unit(index: int) -> tuple[str, str, str]:
    return vocabulary.INDICATORS[index % len(vocabulary.INDICATORS)]


def _disaggregation(index: int, _counts: Mapping[str, int], _status: str) -> str:
    if _indicator_unit(index)[1] != "Number":
        return "None"
    return ("Sex", "Sex", "Sex and age", "None")[index % 4]


def _sensitivity(index: int, _counts: Mapping[str, int], _status: str) -> str:
    category = feedback_category(index)
    if category == SAFEGUARDING:
        return "Restricted – safeguarding"
    return "Sensitive" if category in {"Staff or volunteer conduct", "Fraud or diversion"} \
        else "Standard"  # fmt: skip


def _priority(index: int, _counts: Mapping[str, int], _status: str) -> str:
    category = feedback_category(index)
    if category == SAFEGUARDING:
        return "Critical"
    if category in {"Fraud or diversion", "Exclusion complaint", "Staff or volunteer conduct"}:
        return "High"
    return "Low" if category in {"Appreciation", "Information request"} else "Medium"


def _fund_class(index: int, counts: Mapping[str, int], _status: str) -> str:
    if links.fund_grant(index, counts) is not None:
        return "With donor restrictions – purpose"
    return ("Without donor restrictions", "With donor restrictions – purpose",
            "Perpetual", "With donor restrictions – time")[index % 4]  # fmt: skip


def _fund_source(index: int, counts: Mapping[str, int], _status: str) -> str:
    if links.fund_grant(index, counts) is not None:
        return "Grant"
    return ("General", "Appeal", "Corporate", "Appeal")[index % 4]


def _exclusion(index: int, _counts: Mapping[str, int], status: str) -> str:
    if status in {"Suspended", "Excluded"}:
        return "Flagged"
    return "Not checked" if status == "Prospective" else "Clear"


def _method(index: int, counts: Mapping[str, int], _status: str) -> str:
    kind = finance.disbursement_kind(index, counts)[0]
    if kind == "advance":
        return ("Bank transfer", "Cash")[index % 5 < 2]
    if kind == "order":
        return "Check" if index % 10 < 3 else "Bank transfer"
    return _weighted("disbursements", index, "method", {"Bank transfer": 70, "Check": 15,
                                                        "Mobile money": 10, "Cash": 5})


_PICKERS: dict[tuple[str, str], Callable[[int, Mapping[str, int], str], str]] = {
    ("donors", "donor_type"): lambda i, _c, _s: links.donor_type(i),
    ("donors", "monthly_giving"): lambda i, _c, s: "None" if s == "Prospect" else _weighted(
        "donors", i, "monthly", {"None": 86, "Active": 7, "Lapsed": 3, "Paused": 2, "Closed": 2}),
    ("campaigns", "campaign_type"): lambda i, _c, _s: vocabulary.CAMPAIGNS[
        i % len(vocabulary.CAMPAIGNS)][1],
    ("donations", "payment_method"): _payment_method,
    ("donations", "gift_type"): lambda i, c, _s: ledger.gift_type(i, c),
    ("donations", "restriction"): _restriction,
    ("donations", "acknowledgement"): acknowledgement,
    ("pledges", "frequency"): lambda i, c, _s: links.frequency(links.installments(i, c)),
    ("organizations", "org_type"): lambda i, _c, _s: org_type(i),
    ("organizations", "role"): lambda i, _c, _s: links.org_role(i),
    ("organizations", "due_diligence"): _due_diligence,
    ("budget_lines", "cost_category"): lambda i, _c, _s: text.line_label(i)[1],
    ("expense_lines", "category"): lambda i, _c, _s: text.expense_category(i),
    ("grant_reports", "report_type"): lambda i, _c, _s: _weighted(
        "grant_reports", i, "type", {"Interim narrative": 30, "Interim financial": 30,
                                     "Annual work plan": 12, "Final narrative": 10,
                                     "Final financial": 10, "Audit report": 6,
                                     "Inventory disposition": 2}),
    ("projects", "program_area"): lambda i, _c, _s: project_area(i),
    ("sites", "site_type"): lambda i, _c, _s: "Warehouse" if i == 15 else _weighted(
        "sites", i, "type", {"Community": 78, "School": 12, "Evacuation center": 6,
                             "Market": 4}),
    ("sites", "hazard"): lambda i, _c, _s: ("Storm surge", "Riverine flood", "Coastal flood",
                                            "Landslide", "Riverine flood", "Low")[i % 6],
    ("activities", "activity_type"): lambda i, _c, _s: links.activity_type(i),
    ("beneficiaries", "sex"): lambda i, _c, _s: _weighted(
        "beneficiaries", i, "sex", {"Female": 58, "Male": 41, "Prefer not to say": 1}),
    ("beneficiaries", "vulnerability"): lambda i, _c, _s: _weighted(
        "beneficiaries", i, "vulnerability", {"None recorded": 55, "Female-headed household": 20,
                                              "Older person": 12, "Person with disability": 8,
                                              "Pregnant or lactating": 5}),
    ("assistance", "assistance_type"): lambda i, c, _s: assistance_type(i, c),
    ("indicators", "level"): lambda i, _c, _s: _indicator_unit(i)[0],
    ("indicators", "unit"): lambda i, _c, _s: _indicator_unit(i)[1],
    ("indicators", "frequency"): lambda i, _c, _s: links.indicator_frequency(i),
    ("indicators", "disaggregation"): _disaggregation,
    ("feedback_cases", "category"): lambda i, _c, _s: feedback_category(i),
    ("feedback_cases", "sensitivity"): _sensitivity,
    ("feedback_cases", "priority"): _priority,
    ("funds", "restriction_class"): _fund_class,
    ("funds", "source"): _fund_source,
    ("expense_lines", "receipt_type"): lambda i, _c, _s: _weighted(
        "expense_lines", i, "receipt", {"Official receipt": 65, "Sales invoice": 15,
                                        "Acknowledgement receipt": 15,
                                        "Certified no-receipt": 5}),
    ("disbursements", "disbursement_type"): lambda i, c, _s: disbursement_type(i, c),
    ("disbursements", "method"): _method,
    ("suppliers", "category"): lambda i, _c, _s: vocabulary.SUPPLIERS[
        i % len(vocabulary.SUPPLIERS)][1],
    ("suppliers", "exclusion_check"): _exclusion,
    ("purchase_requests", "method"): lambda i, _c, _s: procurement_method(i),
    ("volunteers", "background_check"): lambda i, _c, _s: _weighted(
        "volunteers", i, "check", {"Cleared": 70, "Not required": 12, "Pending": 12,
                                   "Expired": 6}),
}  # fmt: skip
