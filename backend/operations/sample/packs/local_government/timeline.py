"""Each record's main business day, taken from the records it follows (spec R3).

A child takes its parent's day plus a few working days and is never dated after today;
open work is recent and booked work lies ahead.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import date, timedelta
from functools import lru_cache

from operations.sample.packs.local_government import dates, links, states
from operations.sample.packs.local_government import links_finance as finance
from operations.sample.packs.local_government.dates import SPAN, after, ahead, pick

Counts = tuple[tuple[str, int], ...]
_OPEN_REQUESTS = frozenset({"New", "Acknowledged", "Investigating", "Reopened"})


def _frozen(counts: Mapping[str, int]) -> Counts:
    return tuple(sorted(counts.items()))


def day(module_key: str, index: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    return _day(module_key, index, seed, anchor, _frozen(counts))


@lru_cache(maxsize=262_144)
def _day(module_key: str, index: int, seed: int, anchor: date, frozen: Counts) -> date:
    counts = dict(frozen)
    key = f"{seed}:{module_key}:{index}:day"
    status = states.status_label(module_key, index, seed, counts)

    def parent(module: str, item: int) -> date:
        return _day(module, item, seed, anchor, frozen)

    if module_key == "permit_applications":
        if status in {"Filed", "Verified"} or index == links.ASSESSED_APPLICATION:
            return pick("permit_applications", key, anchor, (-8, 0))
        season = {"Renewal": "renewals", "New": "new_businesses"}.get(
            links.application_type(index, counts), "permit_applications"
        )
        return pick(season, key, anchor, (-SPAN, -2))
    if module_key == "business_inspections":
        if status == "Scheduled":
            return ahead(anchor, key, 1, 21)
        return pick("business_inspections", key, anchor, (-SPAN, -1))
    if module_key == "enforcement_notices":
        inspection = links.notice_inspection(index, counts)
        if inspection is None:
            return pick("enforcement_notices", key, anchor, (-300, -1))
        return after(parent("business_inspections", inspection), key, 1, 5, anchor)
    if module_key == "building_permits":
        if status == "Received":
            return pick("building_permits", key, anchor, (-15, 0))
        return pick("building_permits", key, anchor, (-SPAN, -20))
    if module_key == "building_inspections":
        if status == "Scheduled":
            return ahead(anchor, key, 1, 14)
        filed = parent("building_permits", links.inspection_permit(index, counts))
        rounds = links.inspection_round(index, counts)
        return after(filed, key, 1 + 25 * rounds, 4 + 35 * rounds, anchor)
    if module_key == "service_requests":
        season = ("drainage" if links.work_type(index) == "Declogging and desilting"
                  else "service_requests")  # fmt: skip
        window = (-10, 0) if status in _OPEN_REQUESTS else (-SPAN, -2)
        return pick(season, key, anchor, window)
    if module_key == "work_orders":
        if status == "Planned":
            return ahead(anchor, key, 1, 10)
        latest = max(parent("service_requests", item)
                     for item in links.work_order_requests(index, counts))  # fmt: skip
        return after(latest, key, 1, 5, anchor)
    if module_key == "payment_orders":
        app = finance.oop_application(index, counts)
        if app is not None:
            return after(parent("permit_applications", app), key, 0, 2, anchor)
        permit = finance.oop_permit(index, counts)
        if permit is not None:
            return after(parent("building_permits", permit), key, 3, 12, anchor)
        return pick("payment_orders", key, anchor, (-SPAN, 0))
    if module_key == "official_receipts":
        slot = links.receipt_slot(index, counts)
        if slot is None:
            return pick("official_receipts", key, anchor, (-SPAN, 0))
        order, step = slot
        return after(parent("payment_orders", order), key, 91 * step, 91 * step + 3, anchor)
    if module_key == "deposit_reports":
        return dates.daily_date(index, anchor, counts)
    if module_key == "appropriations":
        return dates.quarter_release(index, anchor)
    if module_key == "obligation_requests":
        po = finance.obr_po(index, counts)
        if po is not None:
            return after(parent("purchase_orders", po), key, 1, 4, anchor)
        return pick("obligation_requests", key, anchor, (-SPAN, 0))
    if module_key == "disbursement_vouchers":
        start = parent("obligation_requests", finance.dv_obligation(index, counts))
        for iar in finance.dv_iars(index, counts):
            start = max(start, accepted_day(iar, seed, anchor, counts))
        if index >= counts["payment_releases"]:
            start = max(start, anchor - timedelta(days=1 + index % 20))
        return after(start, key, 1, 6, anchor)
    if module_key == "payment_releases":
        received = parent("disbursement_vouchers", finance.release_voucher(index, counts))
        return after(received, key, 2, 8, anchor)
    if module_key == "suppliers":
        return pick("suppliers", key, anchor, (-SPAN, -5))
    if module_key == "purchase_requests":
        window = (-SPAN, -50) if status == "Consolidated" else (-60, 0)
        return pick("purchase_requests", key, anchor, window)
    if module_key == "procurement_projects":
        requests = finance.project_requests(index, counts)
        if not requests:
            return pick("procurement_projects", key, anchor, (-340, -40))
        latest = max(parent("purchase_requests", item) for item in requests)
        return after(latest, key, 3, 10, anchor)
    if module_key == "bids":
        return opening_day(finance.bid_project(index, counts), seed, anchor, counts)
    if module_key == "purchase_orders":
        opening = opening_day(finance.po_project(index, counts), seed, anchor, counts)
        return after(opening, key, 15, 35, anchor)
    if module_key == "acceptance_reports":
        po = finance.iar_slot(index, counts)[0]
        ordered = parent("purchase_orders", po)
        lot = 1 + index % 2 if finance.iar_slot(index, counts)[1] != "Partial" else 0
        return after(ordered, key, 7 + 10 * lot, 25 + 12 * lot, anchor)
    if module_key == "communications":
        measures = finance.communication_measures(index, counts)
        if measures:
            measure = measures[0]
            start = approved_day(measure, seed, anchor, counts) or parent(
                "legislative_measures", measure
            )
            return after(start, key, 1, 30 if index else 2, anchor)
        window = (-12, 0) if status in {"Received", "Routed", "In action"} else (-SPAN, -3)
        return pick("communications", key, anchor, window)
    if module_key == "legislative_measures":
        return pick("legislative_measures", key, anchor, (-SPAN, -5))
    if module_key == "civil_registry":
        season = "marriages" if "Marriage" in states.civil_event(index) else "civil_registry"
        return pick(season, key, anchor, (-SPAN, 0))
    if module_key == "business_establishments":
        released = establishment_renewed(index, seed, anchor, counts)
        return released or pick("business_establishments", key, anchor, (-SPAN, -30))
    return pick(module_key, key, anchor, (-SPAN, 0))


def opening_day(project: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    posted = day("procurement_projects", project, seed, anchor, counts)
    return after(posted, f"{seed}:procurement_projects:{project}:opening", 7, 14, anchor)


def accepted_day(iar: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    delivered = day("acceptance_reports", iar, seed, anchor, counts)
    return after(delivered, f"{seed}:acceptance_reports:{iar}:accepted", 0, 3, anchor)


def approved_day(measure: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date | None:
    if finance.measure_stage(measure) not in {"Signed", "Approved on third reading",
                                              "Transmitted to the Mayor", "Vetoed",
                                              "Deemed approved"}:  # fmt: skip
        return None
    filed = day("legislative_measures", measure, seed, anchor, counts)
    return after(filed, f"{seed}:legislative_measures:{measure}:approved", 21, 60, anchor)


def released_day(app: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date | None:
    """A permit is released on or after the day its first receipt was issued."""
    if states.status_label("permit_applications", app, seed, counts) != "Released":
        return None
    filed = day("permit_applications", app, seed, anchor, counts)
    receipts = [receipt for order in finance.application_orders(app, counts)
                for receipt in links.order_receipts(order, counts)]  # fmt: skip
    if receipts:
        filed = max(filed, min(day("official_receipts", item, seed, anchor, counts)
                               for item in receipts))  # fmt: skip
    return after(filed, f"{seed}:permit_applications:{app}:released", 0, 2, anchor)


def establishment_renewed(
    establishment: int, seed: int, anchor: date, counts: Mapping[str, int]
) -> date | None:
    released = [released_day(app, seed, anchor, counts)
                for app in links.establishment_apps(establishment, counts)
                if links.application_type(app, counts) in {"Renewal", "New"}]  # fmt: skip
    found = [item for item in released if item is not None]
    return max(found) if found else None
