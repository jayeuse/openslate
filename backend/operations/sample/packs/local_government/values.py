"""City government choice labels that follow a record's links, amounts and status."""

from __future__ import annotations

import random
from collections.abc import Mapping

from operations.sample.packs.local_government import items, links, money, states, text
from operations.sample.packs.local_government import links_finance as finance
from operations.sample.packs.local_government.links import PINNED
from operations.sample.packs.types import FieldSpec, ModuleSpec
from operations.sample.realism import ordered_skew, weighted_label

_RAINY = frozenset({"Clogged drainage or canal", "Street flooding"})
def _weighted(seed: int, module: str, index: int, field: str, weights: Mapping[str, float]) -> str:
    return weighted_label(random.Random(f"{seed}:{module}:{index}:{field}:choice"), weights)


def procurement_mode(abc_amount: float) -> str:
    """RA 12009: direct acquisition to ₱200,000, small value to ₱2M, then bidding."""
    if abc_amount >= 2_000_000:
        return "Competitive bidding"
    return "Direct acquisition" if abc_amount <= 200_000 else "Small value procurement"


def complexity(permit: int, seed: int) -> str:
    if permit == finance.EVALUATED_PERMIT:
        return "Complex"
    project = text.building_project(permit, seed)
    if project.startswith(("Commercial building", "Warehouse", "Apartment")):
        return "Highly technical" if permit % 4 == 1 else "Complex"
    if project.startswith(("Two-storey", "Second-floor", "Store extension", "Chapel")):
        return "Complex"
    return "Simple"


def scope(permit: int, seed: int) -> str:
    project = text.building_project(permit, seed)
    for start, label in (("Perimeter fence", "Fencing"), ("Billboard", "Signage"),
                         ("Store extension", "Addition"), ("Second-floor", "Addition"),
                         ("Chapel", "Renovation")):  # fmt: skip
        if project.startswith(start):
            return label
    rng = random.Random(f"{seed}:building_permits:{permit}:scope")
    return weighted_label(rng, {"New construction": 70, "Alteration": 10, "Repair": 8,
                                "Legalization": 8, "Demolition": 4})  # fmt: skip


def sla_flag(days: int, limit: int) -> str:
    if days > limit:
        return "Breached"
    return "At risk" if days >= limit - 1 else "On time"


def application_limit(app: int, counts: Mapping[str, int]) -> int:
    """One working day for a renewal, three for a new or amended permit (RA 11032 §9)."""
    return 1 if links.application_type(app, counts) == "Renewal" else 3


def permit_limit(permit: int, seed: int) -> int:
    return {"Simple": 3, "Complex": 7, "Highly technical": 20}[complexity(permit, seed)]


def choice_label(
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    counts: Mapping[str, int],
    status: str,
    days_pending: int | None,
) -> str | None:
    """The option a person picks; ``None`` leaves an optional Select empty."""
    kind, key = field.value_kind, module.key
    if kind == "org_type":
        return text.org_type(index)
    if kind == "line_of_business":
        return text.line_of_business(index)
    if kind == "barangay":
        return text.barangay(key, index, seed)
    if kind == "application_type":
        return links.application_type(index, counts)
    if kind == "sla_flag":
        if days_pending is None:
            return None
        limit = (application_limit(index, counts) if key == "permit_applications"
                 else permit_limit(index, seed))  # fmt: skip
        return sla_flag(days_pending, limit)
    if kind == "business_inspection_type":
        if index < PINNED:
            return "Post-issuance joint inspection"
        return _weighted(seed, key, index, kind, {"Post-issuance joint inspection": 60,
                                                  "Complaint-based": 20, "Re-inspection": 15,
                                                  "Closure verification": 5})  # fmt: skip
    if kind == "notice_type":
        return links.notice_type(index, counts)
    if kind == "violation":
        if links.delinquency_notice(index):
            return "Unpaid tax"
        if index == 0:
            return "Fire safety deficiency"
        return _weighted(
            seed,
            key,
            index,
            kind,
            ordered_skew(field.options[3:] + ("No permit", "Expired permit")),
        )
    if kind == "scope":
        return scope(index, seed)
    if kind == "complexity":
        return complexity(index, seed)
    if kind == "building_inspection_type":
        if index >= PINNED and index % 29 == 13:
            return "Illegal-construction complaint"
        stages = field.options[:6]
        return stages[min(links.inspection_round(index, counts), len(stages) - 1)]
    if kind == "service_type":
        return links.service_type(index)
    if kind == "channel":
        return _weighted(seed, key, index, kind, {"Hotline": 34, "Walk-in": 18, "Online form": 16,
                                                  "Social media": 16, "Barangay referral": 10,
                                                  "Staff-observed": 6})  # fmt: skip
    if kind == "priority":
        service = links.service_type(index)
        if service in _RAINY:
            return None  # Left at Normal; the published rule raises it to High.
        if service == "Open or missing manhole cover":
            return "Emergency" if index % 3 == 0 else "High"
        return _weighted(seed, key, index, kind, {"Normal": 78, "Low": 10, "High": 9,
                                                  "Emergency": 3})  # fmt: skip
    if kind == "work_type":
        return links.work_type(links.work_order_requests(index, counts)[0]) or field.options[0]
    if kind == "crew":
        work = links.work_type(links.work_order_requests(index, counts)[0])
        if work == "Streetlight repair":
            return "Electrical team"
        if work == "Special garbage pickup":
            return "Motorpool"
        return _weighted(seed, key, index, kind, ordered_skew(field.options[:4], alpha=0.5))
    if kind == "oop_source":
        return links.oop_source(index)
    if kind == "receipt_mode":
        return _weighted(seed, key, index, kind, {"Cash": 62, "Online or e-wallet": 18,
                                                  "Check": 14, "Bank deposit": 6})  # fmt: skip
    if kind == "receipt_nature":
        slot = links.receipt_slot(index, counts)
        if slot is None:
            return "Civil registry fee" if index % 4 == 1 else "Other"
        return {
            "Business permit": "Business tax",
            "Building permit": "Building and ancillary fees",
            "Occupancy": "Building and ancillary fees",
            "Civil registry": "Civil registry fee",
            "Real property tax": "RPT basic",
        }.get(links.oop_source(slot[0]), "Other")
    if kind == "release_mode":
        obr = finance.dv_obligation(finance.release_voucher(index, counts), counts)
        if finance.obr_kind(obr, counts) == "Payroll":
            return "ADA direct credit"
        return _weighted(seed, key, index, kind, {"Check": 55, "ADA direct credit": 40,
                                                  "Disbursing officer cash": 5})  # fmt: skip
    if kind == "appropriation_office":
        return text.office(index, "appropriation")
    if kind == "expense_class":
        return finance.expense_class(index)
    if kind == "fund_source":
        return _weighted(seed, key, index, kind, {"Annual": 88, "Supplemental No. 1": 7,
                                                  "Continuing": 3,
                                                  "Supplemental No. 2": 2})  # fmt: skip
    if kind == "requesting_office":
        return requesting_office(key, index, counts)
    if kind == "fund":
        obr = finance.dv_obligation(index, counts)
        if finance.obr_po(obr, counts) is not None and index % 3 == 0:
            return "20% Development Fund"
        return _weighted(seed, key, index, kind, {"General Fund": 84, "Special Education Fund": 8,
                                                  "Trust Fund": 4,
                                                  "20% Development Fund": 4})  # fmt: skip
    if kind == "supplier_type":
        return items.supplier_type(index)
    if kind == "recommended_mode":
        if status in {"Draft", "Submitted"}:
            return None
        return procurement_mode(float(money.abc(index)))
    if kind == "mode":
        return procurement_mode(float(money.project_abc(index, counts)))
    if kind == "timeline_flag":
        if days_pending is None or status in {"Contract signed", "Notice to proceed", "Awarded"}:
            return "On track"
        return (
            "Over 60-day cap"
            if days_pending > 60
            else ("At risk" if days_pending > 45 else "On track")
        )
    if kind == "eligibility":
        if finance.bid_rank(index, counts) == 1:
            return "Eligible"
        return _weighted(seed, key, index, kind, {"Eligible": 90, "Ineligible": 10})
    if kind == "evaluation":
        return _evaluation(index, seed, counts, status)
    if kind == "direction":
        return text.direction(index)
    if kind == "document_type":
        if finance.communication_measures(index, counts):
            return "Transmittal"
        return _weighted(seed, key, index, kind, ordered_skew(field.options, alpha=0.8))
    if kind == "action_required":
        if text.direction(index) != "Incoming":
            return "For signature" if index == 0 else None
        return _weighted(seed, key, index, kind, {"For appropriate action": 46,
                                                  "For information": 30, "For comment": 8,
                                                  "For compliance": 7, "For signature": 5,
                                                  "FOI request": 4})  # fmt: skip
    if kind == "routed_to":
        if index == 0:
            return "Office of the City Mayor"
        return text.office(index, "routed") if text.direction(index) == "Incoming" else None
    if kind == "urgency":
        return _weighted(seed, key, index, kind, {"Routine": 85, "Urgent": 15})
    if kind == "measure_kind":
        return text.measure_kind(index)
    if kind == "committee":
        if index == links.THIRD_READING_MEASURE:
            return "Ways and Means"
        return _weighted(seed, key, index, kind, ordered_skew(field.options, alpha=0.7))
    if kind == "civil_event":
        return states.civil_event(index)
    if kind == "timeliness":
        return "Delayed" if states.civil_delayed(index) else "Timely"
    if index < PINNED:
        return field.options[(index * 7 + seed) % len(field.options)]
    return _weighted(seed, key, index, field.key, ordered_skew(field.options))


def _evaluation(bid: int, seed: int, counts: Mapping[str, int], status: str) -> str | None:
    if status != "Opened":
        return None
    project = finance.bid_project(bid, counts)
    rank = finance.bid_rank(bid, counts)
    awarded = finance.project_class(project) == "awarded"
    if rank == 1:
        return "Lowest calculated responsive bid" if awarded else "Lowest calculated"
    if not awarded:
        return "Pending"
    return _weighted(seed, "bids", bid, "evaluation", {"Responsive": 80, "Non-responsive": 15,
                                                       "Post-disqualified": 5})  # fmt: skip


def requesting_office(module_key: str, index: int, counts: Mapping[str, int]) -> str:
    if module_key == "purchase_requests":
        return text.procurement_item(index)[1]
    po = finance.obr_po(index, counts)
    if po is not None:
        requests = finance.project_requests(finance.po_project(po, counts), counts)
        return text.procurement_item(requests[0])[1] if requests else "General Services Office"
    if finance.obr_kind(index, counts) == "Payroll":
        return text.office(index, "payroll")
    return text.office(index, "obligation")
