"""Business dates, counters and details of city government records."""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date, time, timedelta

from operations.sample.packs.local_government import (
    dates,
    links,
    money,
    states,
    text,
    timeline,
    vocabulary,
)
from operations.sample.packs.local_government import links_finance as finance
from operations.sample.packs.local_government.values import requesting_office
from operations.sample.packs.types import OMIT, FieldSpec, JsonValue, ModuleSpec

_DONE_APPLICATIONS = frozenset({"Released", "Approved", "Paid"})
_PERMIT_DONE = frozenset({"Permit issued", "Under construction", "Completed", "Deemed approved",
                          "Expired", "Paid"})  # fmt: skip
_OPEN_COMMUNICATIONS = frozenset({"Received", "Routed", "In action"})


def _working_days(start: date, end: date) -> int:
    days, current = 0, start
    while current < end:
        current += timedelta(days=1)
        if current.weekday() < 5:
            days += 1
    return days


def days_pending(
    module_key: str, index: int, seed: int, anchor: date, counts: Mapping[str, int], status: str
) -> int | None:
    """The stored counter people update (plan rule 6): days in process, or days so far."""
    rng = random.Random(f"{seed}:{module_key}:{index}:days")
    if module_key == "permit_applications":
        if status in _DONE_APPLICATIONS:
            return rng.choices((0, 1, 2, 3, 4, 6), weights=(30, 42, 14, 8, 4, 2))[0]
        if status in {"Filed", "Verified", "Assessed"}:
            filed = timeline.day(module_key, index, seed, anchor, counts)
            return min(60, _working_days(filed, anchor))
        return None
    if module_key == "building_permits":
        if index == finance.EVALUATED_PERMIT:
            return 6  # The live input raises it to 9, past the 7-day limit for a complex permit.
        if status in _PERMIT_DONE:
            return rng.randint(2, 9)
        if status in {"Received", "Site inspected", "Under evaluation", "For payment"}:
            filed = timeline.day(module_key, index, seed, anchor, counts)
            return min(90, _working_days(filed, anchor))
        return None
    if module_key == "disbursement_vouchers":
        if status in {"Paid", "Approved for payment"}:
            return rng.randint(1, 6)
        received = timeline.day(module_key, index, seed, anchor, counts)
        return min(90, _working_days(received, anchor))
    if module_key == "procurement_projects":
        if not finance.project_bids(index, counts):
            return None
        opening = timeline.opening_day(index, seed, anchor, counts)
        if status in {"Contract signed", "Notice to proceed", "Awarded"}:
            return rng.randint(14, 48)
        return min(400, (anchor - opening).days)
    return None


def date_value(
    module: ModuleSpec, field: FieldSpec, index: int, seed: int, anchor: date,
    counts: Mapping[str, int], status: str,
) -> date | str | None:  # fmt: skip
    """A Date field's day, or a Date/Time field's stamp; ``None`` leaves it empty."""
    key, kind = module.key, field.value_kind
    main = timeline.day(key, index, seed, anchor, counts)
    salt = f"{seed}:{key}:{index}:{field.key}"
    if kind in {"filed_on", "inspected_on", "issued_on", "scheduled_on", "requested_on",
                "assessed_on", "daily_date", "prepared_on", "allotted_on", "received_on",
                "review_date", "submitted_on", "po_date", "delivered_on", "dated_on",
                "registered_on"}:  # fmt: skip
        return main
    if kind == "posted_on":
        return None if status == "Pre-procurement conference" else main
    if kind == "last_renewed":
        return timeline.establishment_renewed(index, seed, anchor, counts)
    if kind == "released_on" and key == "permit_applications":
        return timeline.released_day(index, seed, anchor, counts)
    if kind == "released_on":
        return (
            dates.after(main, salt, 0, 3, anchor)
            if status in {"Released", "Cleared", "Stale"}
            else None
        )
    if kind == "comply_by":
        return _ahead(main, salt, 7, 15) if status in {"With findings", "Failed"} else None
    if kind == "requested_at":
        return dates.entry_stamp(main, salt)
    if kind == "expected_by":
        open_states = {"New", "Acknowledged", "Investigating", "Action scheduled", "In progress"}
        return _ahead(main, salt, 3, 10) if status in open_states else None
    if kind == "completed_on":
        return (
            dates.after(main, salt, 0, 2, anchor) if status in {"Completed", "Verified"} else None
        )
    if kind == "due_on" and key == "payment_orders":
        return _ahead(main, salt, 20, 20)
    if kind == "due_on":
        if status not in _OPEN_COMMUNICATIONS:
            return None
        return _ahead(main, salt, 5, 15)
    if kind == "deposit_date":
        return None if status == "Draft" else dates.after(main, salt, 0, 1, anchor)
    if kind == "bid_opening":
        if not finance.project_bids(index, counts):
            return None
        opening = timeline.opening_day(index, seed, anchor, counts)
        return dates.stamp(opening, time(10 if index % 3 else 14, 0))
    if kind == "delivery_due":
        return _ahead(main, salt, delivery_days(index), delivery_days(index))
    if kind == "accepted_on":
        if status.startswith("Rejected"):
            return None
        return timeline.accepted_day(index, seed, anchor, counts)
    if kind == "approved_on":
        return timeline.approved_day(index, seed, anchor, counts)
    if kind == "effective_on":
        approved = timeline.approved_day(index, seed, anchor, counts)
        return None if approved is None or status != "Signed" else _ahead(approved, salt, 15, 30)
    if kind == "event_date":
        return _event_day(index, main, salt, anchor)
    raise ValueError(f"Unsupported city government date {key}.{field.key}")


def _ahead(day: date, salt: str, low: int, high: int) -> date:
    """A later day that may lie past today, as a due date does."""
    return day + timedelta(days=random.Random(salt).randint(low, high))


def _event_day(entry: int, registered: date, salt: str, anchor: date) -> date:
    rng = random.Random(salt)
    event = states.civil_event(entry)
    if states.civil_delayed(entry):
        delay = rng.randint(31, 200)
    elif event == "Marriage license application":
        delay = 0
    else:
        delay = rng.randint(0, {"Birth": 29, "Death": 10}.get(event, 14))
    return dates.clamp_past(registered - timedelta(days=delay), anchor)


def delivery_days(po: int) -> int:
    return (15, 30, 30, 45, 60)[po % 5]


def detail_value(
    module: ModuleSpec, field: FieldSpec, index: int, seed: int, anchor: date,
    counts: Mapping[str, int], status: str,
) -> JsonValue | object:  # fmt: skip
    """Text and number details; ``OMIT`` leaves an optional field empty."""
    kind, key = field.value_kind, module.key
    rng = random.Random(f"{seed}:{key}:{index}:{field.key}:detail")
    if kind == "trade_name":
        if rng.random() < 0.6:
            return OMIT
        word = vocabulary.BUSINESS_WORDS[(index * 11 + seed) % len(vocabulary.BUSINESS_WORDS)]
        return f"{word} {vocabulary.BUSINESS_SIGNS[text.line_of_business(index)]}"
    if kind == "taxpayer":
        return text.taxpayer(index, seed)
    if kind == "street_address":
        return f"{text.street_address(key, index, seed)}, {text.barangay(key, index, seed)}"
    if kind == "employees":
        corporate = text.org_type(index) != "Sole proprietorship"
        return rng.randint(8, 140) if corporate else rng.choice((1, 1, 2, 2, 3, 4, 5, 8))
    if kind == "year_started":
        if links.new_business(index):
            return anchor.year
        return anchor.year - min(40, int(rng.expovariate(1 / 9)) + 1)
    if kind == "tax_year":
        filed = timeline.day(key, index, seed, anchor, counts)
        early = filed.month == 12 and links.application_type(index, counts) == "Renewal"
        return filed.year + early
    if kind == "declared_gross":
        return money.declared_gross(index, counts)
    if kind == "permit_no":
        done = _DONE_APPLICATIONS if key == "permit_applications" else _PERMIT_DONE - {"Paid"}
        if status not in done:
            return OMIT
        return f"{'MP' if key == 'permit_applications' else 'BP'}-{2_041 + index * 3:05d}"
    if kind == "agencies":
        return ("BPLO, City Health, Fire, Zoning", "BPLO, City Health, Fire",
                "BPLO, Zoning")[index % 3]  # fmt: skip
    if kind in {"business_findings", "building_findings"}:
        pool = (
            vocabulary.BUSINESS_FINDINGS
            if kind == "business_findings"
            else (vocabulary.BUILDING_FINDINGS)
        )
        if status in {"Scheduled", "Cancelled"}:
            return OMIT
        if status in {"Complied", "Passed"}:
            return pool[-1] if rng.random() < 0.7 else pool[rng.randrange(len(pool) - 1)]
        return pool[rng.randrange(len(pool) - 1)]
    if kind == "compliance_days":
        return {"Notice of violation": 7, "Notice of delinquency": 15, "Cease and desist": 3,
                "Closure order": 1}.get(links.notice_type(index, counts), OMIT)  # fmt: skip
    if kind == "building_project":
        return text.building_project(index, seed)
    if kind == "estimated_cost":
        return money.estimated_cost(index)
    if kind == "request_description":
        if status == "Duplicate":
            return "Same report as an earlier request on this street."
        options = vocabulary.SR_DESCRIPTIONS[links.service_type(index)]
        return options[rng.randrange(len(options))]
    if kind == "materials":
        if status in {"Planned", "Dispatched", "Cancelled"}:
            return OMIT
        work = links.work_type(links.work_order_requests(index, counts)[0])
        options = vocabulary.WORK_MATERIALS.get(work or "", ("Hand tools only",))
        return options[rng.randrange(len(options))]
    if kind == "labor_hours":
        if status not in {"Completed", "Verified"}:
            return OMIT
        return rng.choice((2, 3, 4, 4, 6, 8, 8, 12, 16, 24)) + rng.choice((0, 0.5))
    if kind == "payor":
        if key == "payment_orders":
            return text.payor(index, seed, counts)
        slot = links.receipt_slot(index, counts)
        return (
            text.payor(slot[0], seed, counts) if slot else text.person_name(index, seed, "walk-in")
        )
    if kind == "amount_due":
        return money.amount_due(index, counts)
    if kind == "surcharge":
        return money.surcharge(index, counts) or OMIT
    if kind == "oop_balance":
        return money.balance(index, counts, status)
    if kind == "fee_breakdown":
        return _fee_breakdown(index, counts)
    if kind == "receipt_amount":
        return money.receipt_amount(index, counts)
    if kind in {"or_from", "or_to", "total_collected", "deposited_amount"}:
        return _deposit(index, anchor, counts, kind, status)
    if kind == "payee":
        obr = {"payment_releases": lambda: finance.dv_obligation(
                   finance.release_voucher(index, counts), counts),
               "disbursement_vouchers": lambda: finance.dv_obligation(index, counts),
               "obligation_requests": lambda: index}[key]()  # fmt: skip
        return text.obr_payee(obr, seed, counts)
    if kind == "release_amount":
        return money.dv_net(finance.release_voucher(index, counts), counts)
    if kind == "account_code":
        return text.account_code(index)
    if kind == "fiscal_year":
        return anchor.year
    if kind == "appropriated_amount":
        return money.appropriated(index)
    if kind == "allotted_amount":
        quarters = min(4, (anchor.month - 1) // 3 + 1)
        return money.cents(float(money.appropriated(index)) * quarters / 4)
    if kind == "particulars":
        return _particulars(key, index, seed, counts)
    if kind == "obr_amount":
        return money.obr_amount(index, counts)
    if kind == "gross_amount":
        return money.dv_gross(index, counts)
    if kind == "tax_withheld":
        return money.dv_tax(index, counts) or OMIT
    if kind == "net_amount":
        return money.dv_net(index, counts)
    if kind == "claim_certifier":
        office = requesting_office("obligation_requests", finance.dv_obligation(index, counts),
                                   counts)  # fmt: skip
        return _HEADS.get(office, "City Administrator")
    if kind == "journal_entry":
        return f"JEV-{3_120 + index:05d}" if status in {"Paid", "Approved for payment"} else OMIT
    if kind == "tin":
        return f"{(index * 271 + 104) % 900 + 100:03d}-{(index * 613 + 37) % 900 + 100:03d}-" \
               f"{(index * 97 + 501) % 900 + 100:03d}-000"  # fmt: skip
    if kind == "registry_no":
        return OMIT if rng.random() < 0.15 else f"REG-{51_204 + index * 7:06d}"
    if kind == "contact_person":
        return text.person_name(index, seed, "contact")
    if kind == "supplier_address":
        return f"{text.street_address(key, index, seed)}, {text.barangay(key, index, seed)}"
    if kind == "pr_purpose":
        item, office, _type = text.procurement_item(index)
        return f"For the use of the {office}: {item[0].lower()}{item[1:]}."
    if kind == "item_summary":
        return text.procurement_item(index)[0]
    if kind == "abc_amount":
        return money.abc(index)
    if kind == "project_abc":
        return money.project_abc(index, counts)
    if kind == "bac_resolution":
        if status not in {"Awarded", "Contract signed", "Notice to proceed",
                          "Recommended for award"}:  # fmt: skip
            return OMIT
        return f"BAC Res. No. {31 + index:03d}"
    if kind == "bid_amount":
        return money.bid_amount(index, counts)
    if kind == "bid_rank":
        return finance.bid_rank(index, counts) if status == "Opened" else OMIT
    if kind == "po_amount":
        return money.po_amount(index, counts)
    if kind == "delivery_days":
        return delivery_days(index)
    if kind == "delivery_place":
        return ("General Services Office warehouse, City Hall", "City Engineering motorpool yard",
                "City Hall annex, ground floor")[index % 3]  # fmt: skip
    if kind == "po_approver":
        return "City Mayor, head of the procuring entity"
    if kind == "invoice_no":
        return f"SI-{18_430 + index * 3:05d}"
    if kind == "correspondent":
        return text.communication_parts(index, seed, counts)[1]
    if kind == "measure_amount":
        if text.measure_kind(index) != "Appropriation ordinance":
            return OMIT
        return money.cents(float(money.appropriated(index + 7_000)) * 4)
    if kind == "authors":
        first = vocabulary.COUNCILORS[(index * 3 + seed) % len(vocabulary.COUNCILORS)]
        second = vocabulary.COUNCILORS[(index * 7 + seed + 1) % len(vocabulary.COUNCILORS)]
        return first if first == second or rng.random() < 0.6 else f"{first}; {second}"
    raise ValueError(f"Unsupported city government field {key}.{field.key}")


_HEADS = {
    "Office of the City Mayor": "City Mayor", "City Engineering Office": "City Engineer",
    "Business Permits and Licensing": "BPLO Chief",
    "Office of the Building Official": "Building Official",
    "City Treasurer's Office": "City Treasurer", "City Budget Office": "City Budget Officer",
    "City Accounting Office": "City Accountant",
    "General Services Office": "City General Services Officer",
    "Sangguniang Panlungsod": "City Vice Mayor", "City Civil Registry": "City Civil Registrar",
    "City Health Office": "City Health Officer",
    "City Disaster Risk Reduction Office": "City Disaster Risk Reduction Officer",
}  # fmt: skip


def _fee_breakdown(order: int, counts: Mapping[str, int]) -> str:
    source = links.oop_source(order)
    if source == "Business permit":
        items = "Business tax; mayor's permit fee; garbage fee; sanitary inspection fee"
    elif source in {"Building permit", "Occupancy"}:
        items = "Building permit fee; line and grade fee; electrical, mechanical and plumbing fees"
    else:
        items = {
            "Civil registry": "Marriage license fee; certified true copy fee",
            "Real property tax": "RPT basic; RPT SEF",
        }.get(source, "Certification fee")
    total = float(money.amount_due(order, counts)) + float(money.surcharge(order, counts))
    return f"{items}. Total ₱{total:,.2f}."


def _particulars(key: str, index: int, seed: int, counts: Mapping[str, int]) -> str:
    obr = index if key == "obligation_requests" else finance.dv_obligation(index, counts)
    po = finance.obr_po(obr, counts)
    if po is not None:
        project = finance.po_project(po, counts)
        requests = finance.project_requests(project, counts)
        item = text.procurement_item(requests[0] if requests else project + 500)[0]
        code = text.reference_code("purchase_orders", po, seed)
        return f"Payment for {item[0].lower()}{item[1:]} under {code}."
    kind = finance.obr_kind(obr, counts)
    if kind == "Payroll":
        return f"Salaries and wages for the period, {text.office(obr, 'payroll')}."
    if kind == "Utilities":
        return "Electricity, water and telephone bills for the month."
    if kind == "Travel":
        return "Travel expenses to the regional seminar, with the itinerary attached."
    return "Financial assistance under the approved program, with supporting documents."


def _deposit(
    report: int, anchor: date, counts: Mapping[str, int], kind: str, status: str
) -> JsonValue | object:
    series = _receipt_series(anchor, counts["deposit_reports"])
    start, issued, total = series[report]
    if kind == "or_from":
        return f"{start:07d}"
    if kind == "or_to":
        return f"{start + issued - 1:07d}"
    if kind == "total_collected":
        return total
    if status == "Draft":
        return OMIT
    short = (
        0.0
        if status != "Discrepancy"
        else random.Random(f"lg:short:{report}").choice((50.0, 100.0, 250.0, 500.0))
    )
    return money.cents(float(total) - short)


_SERIES: dict[tuple[date, int], tuple[tuple[int, int, int | float], ...]] = {}


def _receipt_series(anchor: date, reports: int) -> tuple[tuple[int, int, int | float], ...]:
    """Each day's first OR number, receipts issued and total: January holds the renewal peak."""
    cached = _SERIES.get((anchor, reports))
    if cached is not None:
        return cached
    counts = {"deposit_reports": reports}
    rows: list[tuple[int, int, int | float]] = []
    start = 7_201_001
    for report in range(reports):
        day = dates.daily_date(report, anchor, counts)
        rng = random.Random(f"lg:collections:{report}")
        peak = (
            6.0
            if day.month == 1 and day.day <= 20
            else (2.2 if day.month in {4, 7, 10} and day.day <= 20 else 1.0)
        )
        issued = max(5, int(rng.gauss(40, 8) * peak))
        total = money.cents(issued * rng.uniform(1_800, 4_800) * (1.6 if peak > 5 else 1.0))
        rows.append((start, issued, total))
        start += issued
    result = tuple(rows)
    _SERIES[(anchor, reports)] = result
    return result
