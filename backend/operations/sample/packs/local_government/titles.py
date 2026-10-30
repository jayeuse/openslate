"""Record titles a city hall's staff would type; linked names follow the same link rules.

``record_title`` also names records past the planned count (the OpenView lifecycle control
asks for a fresh one), so every lookup wraps its index into the planned range.
"""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample.packs.local_government import links, states, text
from operations.sample.packs.local_government import links_finance as finance


def _wrap(index: int, counts: Mapping[str, int], module_key: str) -> int:
    return index % max(1, counts[module_key])


def _code(module_key: str, index: int, seed: int) -> str:
    return text.reference_code(module_key, index, seed) or f"{index + 1:05d}"


def _business(establishment: int, seed: int) -> str:
    return text.business_name(establishment, seed)


def record_title(module_key: str, index: int, seed: int, counts: Mapping[str, int]) -> str:
    sized = dict(counts)
    code = _code(module_key, index, seed)
    if module_key == "business_establishments":
        if index >= sized[module_key]:
            return f"{_business(index, seed)} — branch {index // sized[module_key] + 1}"
        return _business(index, seed)
    if module_key == "permit_applications":
        app = _wrap(index, sized, module_key)
        business = _business(links.application_establishment(app, sized), seed)
        return f"{business} — {links.application_type(app, sized).lower()} {code}"
    if module_key == "business_inspections":
        inspection = _wrap(index, sized, module_key)
        business = _business(links.inspection_establishment(inspection, sized), seed)
        return f"{business} — inspection {code}"
    if module_key == "enforcement_notices":
        notice = _wrap(index, sized, module_key)
        business = _business(links.notice_establishment(notice, sized), seed)
        return f"{links.notice_type(notice, sized)} {code} — {business}"
    if module_key == "building_permits":
        return f"{text.building_project(index, seed)} ({code})"
    if module_key == "building_inspections":
        permit = links.inspection_permit(_wrap(index, sized, module_key), sized)
        return f"{_code('building_permits', permit, seed)} inspection {code}"
    if module_key in {"service_requests", "work_orders"}:
        request = index
        if module_key == "work_orders":
            request = links.work_order_requests(_wrap(index, sized, module_key), sized)[0]
        place = text.street_address("service_requests", request, seed).split(", ")[-1]
        place = place.split(" ", 1)[-1] if place[0].isdigit() else place
        label = (
            links.service_type(request)
            if module_key == "service_requests"
            else (links.work_type(request) or "Road maintenance")
        )
        return f"{label} — {place}, {text.barangay('service_requests', request, seed)} ({code})"
    if module_key == "payment_orders":
        order = _wrap(index, sized, module_key)
        return f"{links.oop_source(order)} {code} — {text.payor(order, seed, sized)}"
    if module_key == "official_receipts":
        receipt = _wrap(index, sized, module_key)
        slot = links.receipt_slot(receipt, sized)
        payor = (text.payor(slot[0], seed, sized) if slot
                 else text.person_name(receipt, seed, "walk-in"))  # fmt: skip
        return f"OR {code} — {payor}"
    if module_key == "deposit_reports":
        return f"Collection deposit report {code}"
    if module_key == "payment_releases":
        release = _wrap(index, sized, module_key)
        dv = finance.release_voucher(release, sized)
        payee = text.obr_payee(finance.dv_obligation(dv, sized), seed, sized)
        return f"Check {code} — {payee}"
    if module_key == "appropriations":
        office = text.office(index, "appropriation")
        return f"{office} — {text.account_title(index)} ({text.account_code(index)})"
    if module_key == "obligation_requests":
        obr = _wrap(index, sized, module_key)
        return f"ObR {code} — {text.obr_payee(obr, seed, sized)}"
    if module_key == "disbursement_vouchers":
        dv = _wrap(index, sized, module_key)
        payee = text.obr_payee(finance.dv_obligation(dv, sized), seed, sized)
        return f"DV {code} — {payee}"
    if module_key == "suppliers":
        return text.supplier_name(index)
    if module_key == "purchase_requests":
        return f"{text.procurement_item(index)[0]} ({code})"
    if module_key == "procurement_projects":
        project = _wrap(index, sized, module_key)
        requests = finance.project_requests(project, sized)
        item = text.procurement_item(requests[0] if requests else index + 500)[0]
        return f"{code} — supply and delivery: {item[0].lower()}{item[1:]}"
    if module_key == "bids":
        bid = _wrap(index, sized, module_key)
        supplier = text.supplier_name(finance.bid_supplier(bid, sized))
        tender = _code("procurement_projects", finance.bid_project(bid, sized), seed)
        return f"{supplier} — {tender} ({code})"
    if module_key == "purchase_orders":
        po = _wrap(index, sized, module_key)
        return f"{code} — {text.supplier_name(finance.po_supplier(po, sized))}"
    if module_key == "acceptance_reports":
        po = finance.iar_slot(_wrap(index, sized, module_key), sized)[0]
        return f"{code} — {_code('purchase_orders', po, seed)}"
    if module_key == "communications":
        return f"{text.communication_subject(index, seed, sized)} ({code})"
    if module_key == "legislative_measures":
        return text.measure_title(index)
    if module_key == "civil_registry":
        return f"{states.civil_event(index)} — {code}"
    raise ValueError("Unknown city government module")
