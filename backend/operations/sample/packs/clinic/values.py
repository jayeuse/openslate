"""Clinic choice labels and business dates that follow a record's links and status."""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date, time, timedelta
from functools import lru_cache

from operations.sample.packs.clinic import dates, ledger, links, text
from operations.sample.packs.clinic.catalog_fields import EM_CODES
from operations.sample.packs.clinic.links import PINNED
from operations.sample.packs.types import OMIT, FieldSpec, ModuleSpec
from operations.sample.realism import ordered_skew, weighted_label

_PAYER_CLASS = {"Commercial insurer": "Commercial insurance", "HMO": "Commercial insurance",
                "Medicare": "Medicare", "Medicaid managed care": "Medicaid",
                "Employer account": "Employer account"}  # fmt: skip
_SUPPLIER_CATEGORIES = (
    "Medical supplies", "Lab reagents", "Pharmaceuticals", "Equipment service",
    "Office supplies", "Medical supplies", "Lab reagents", "Pharmaceuticals", "Pharmaceuticals",
    "Medical supplies", "Medical supplies", "Equipment service",
)  # fmt: skip
_DENIALS = ("CO-16 Claim lacks information", "CO-197 Authorization missing",
            "CO-50 Not medically necessary", "CO-27 Coverage ended", "CO-97 Included in another "
            "service", "CO-22 Another payer may cover", "CO-31 Patient not identified")  # fmt: skip

type Counts = tuple[tuple[str, int], ...]


def _frozen(counts: Mapping[str, int]) -> Counts:
    return tuple(sorted(counts.items()))


def _weighted(seed: int, module: str, index: int, field: str, weights: Mapping[str, float]) -> str:
    return weighted_label(random.Random(f"{seed}:{module}:{index}:{field}:choice"), weights)


def payer_class(patient: int, counts: Mapping[str, int]) -> str:
    coverage = links.patient_coverage(patient, counts)
    if coverage is None:
        return "Self-pay"
    return _PAYER_CLASS[text.payer(links.coverage_payer(coverage, counts))[1]]


def em_code(encounter: int, seed: int) -> str:
    rng = random.Random(f"{seed}:encounters:{encounter}:em")
    return weighted_label(rng, ordered_skew(EM_CODES, alpha=1.3))


def result_flag(result: int) -> str:
    if result == 0:
        return "Critical high"
    weights = {"Normal": 78, "High": 10, "Low": 6, "Abnormal": 4, "Critical high": 1,
               "Critical low": 1}  # fmt: skip
    return weighted_label(random.Random(f"clinic:flag:{result}"), weights)


def lot_months(lot: int, status: str) -> int:
    """Months from the anchor month to the lot's expiry."""
    if status == "Expired":
        return -1 - lot % 3
    return 2 + (lot * 5) % 30


def _response_decision(response: int, counts: Mapping[str, int]) -> str:
    claim = links.response_claim(response, counts)
    if links.first_decision_reversed(claim, counts) and not links.second_response(
        response, counts
    ):
        return "Denied"
    return {"Paid": "Approved", "Partially paid": "Partially approved",
            "Returned for correction": "Returned for correction"}.get(
        links.claim_class(claim), "Denied")  # fmt: skip


def choice_label(
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
    status: str,
) -> str | None:
    """The option a person picks; ``None`` leaves an optional Select empty."""
    kind, key = field.value_kind, module.key
    if kind == "sex":
        return _weighted(seed, key, index, kind, {"Female": 52, "Male": 46, "Other": 1,
                                                  "Unknown": 1})  # fmt: skip
    if kind == "payer_class":
        return payer_class(index, counts)
    if kind == "billing_class":
        if index == links.SELF_PAY_VISIT:
            return "Self-pay"
        return payer_class(links.encounter_patient(index, counts), counts)
    if kind == "payer_type":
        return text.payer(index)[1]
    if kind == "eligibility":
        return _weighted(seed, key, index, kind, {"Eligible": 86, "Not checked": 7,
                                                  "Not eligible": 4,
                                                  "Needs prior authorization": 3})  # fmt: skip
    if kind == "visit_type":
        if key == "encounters":
            appointment = links.encounter_appointment(index, counts)
            if appointment is None:
                return "Acute same-day"
            key, index = "appointments", appointment
        return weighted_label(random.Random(f"{seed}:appointments:{index}:visit"),
                              ordered_skew(field.options, alpha=0.9))  # fmt: skip
    if kind == "reminder":
        if status == "No-show":
            return ("No answer", "Callback requested")[index % 2]
        return _weighted(seed, key, index, kind, {"Confirmed": 70, "Not sent": 14,
                                                  "No answer": 11,
                                                  "Callback requested": 5})  # fmt: skip
    if kind == "cancel_reason":
        if status != "Cancelled":
            return None
        return _weighted(seed, key, index, kind, {"Patient request": 55,
                                                  "Cancelled under 24 hours": 30,
                                                  "Provider unavailable": 8,
                                                  "Duplicate booking": 4,
                                                  "Left without being seen": 3})  # fmt: skip
    if kind == "em_code":
        return em_code(index, seed)
    if kind == "disposition":
        if status != "Finished":
            return None
        return _weighted(seed, key, index, kind, {"Home": 78, "Follow-up booked": 15,
                                                  "Referred": 6, "Sent to ED": 1})  # fmt: skip
    if kind == "order_category":
        return links.order_category(index)
    if kind == "priority":
        return _weighted(seed, key, index, kind, {"Routine": 85, "Urgent": 9, "ASAP": 4,
                                                  "STAT": 2})  # fmt: skip
    if kind == "performer":
        category = links.order_category(index)
        if category == "Imaging":
            return "Outside imaging"
        if category == "Procedure":
            return None
        return "Reference lab" if index >= PINNED and index % 6 == 5 else "In-house lab"
    if kind == "fill_at":
        return "In-house dispensary" if links.filled_in_house(index) else "Outside pharmacy"
    if kind == "specimen_type":
        return text.lab_service(links.specimen_orders(index, counts)[0])[4]
    if kind == "rejection_reason":
        if status != "Unsatisfactory":
            return None
        return _weighted(seed, key, index, kind, ordered_skew(field.options))
    if kind == "result_flag":
        return "Normal" if status == "Cancelled" else result_flag(index)
    if kind == "qc_level":
        return field.options[index % 3]
    if kind == "qc_rule":
        if status == "Failed":
            return ("1-3s", "R-4s")[index % 2]
        if status == "Repeated and passed":
            return ("2-2s", "1-2s warning")[index % 2]
        return "1-2s warning" if index % 17 == 5 else "None"
    if kind == "dosage_form":
        return text.item(index)[2]
    if kind == "expiry_band":
        months = lot_months(index, status)
        return ("Expired" if months < 0 else "Under 3 months" if months < 3
                else "3 to 6 months" if months <= 6 else "More than 6 months")  # fmt: skip
    if kind == "lot_location":
        if text.item(links.lot_item(index, counts))[3]:
            return ("Vaccine fridge 1", "Pharmacy fridge 2")[index % 2]
        return ("Dispensary shelf", "Dispensary shelf", "Stockroom")[index % 3]
    if kind == "shift":
        return ("AM", "PM")[index % 2]
    if kind == "response_decision":
        return _response_decision(index, counts)
    if kind == "response_outcome":
        decision = _response_decision(index, counts)
        return {"Approved": "Complete", "Partially approved": "Partial",
                "Returned for correction": "Error"}.get(decision, "Complete")  # fmt: skip
    if kind == "carc":
        decision = _response_decision(index, counts)
        if decision in {"Denied", "Returned for correction"}:
            return _DENIALS[index % len(_DENIALS)]
        if decision == "Partially approved":
            return ("CO-45 Charge exceeds fee schedule", "PR-2 Coinsurance")[index % 2]
        return "PR-3 Copayment" if index % 3 else None
    if kind == "payment_source":
        return "Payer remittance" if links.payment_claim(index, counts) is not None else "Patient"
    if kind == "payment_method":
        if links.payment_claim(index, counts) is not None:
            return "Payer EFT" if index % 9 else "Check"
        return _weighted(seed, key, index, kind, {"Card": 55, "Cash": 25, "Mobile wallet": 10,
                                                  "Check": 5, "Bank transfer": 5})  # fmt: skip
    if kind == "supplier_category":
        return _SUPPLIER_CATEGORIES[index % len(_SUPPLIER_CATEGORIES)]
    if kind == "request_reason":
        if index == 0:
            return "Reorder level"
        return _weighted(seed, key, index, kind, {"Reorder level": 55, "New item": 20,
                                                  "Stock-out": 15, "Project": 10})  # fmt: skip
    if kind == "wo_type":
        if index == 0:
            return "Corrective repair"
        return _weighted(seed, key, index, kind, {"Preventive maintenance": 50,
                                                  "Corrective repair": 22, "Calibration": 20,
                                                  "Electrical safety check": 8})  # fmt: skip
    if kind == "wo_result":
        if status != "Completed":
            return None
        return _weighted(seed, key, index, kind, {"Pass": 85, "Adjusted then pass": 12,
                                                  "Fail": 3})  # fmt: skip
    if kind == "incident_type":
        return text.incident(index)[1]
    if kind == "harm":
        return text.incident(index)[2]
    if kind == "credential_type":
        return text.credential(index)[1]
    if kind == "credential_band":
        return {"Expiring soon": "30 days or less", "Expired": "Expired"}.get(
            status, "31 to 90 days" if index % 13 == 4 else "More than 90 days")  # fmt: skip
    if index < PINNED:
        return field.options[(index * 7 + seed) % len(field.options)]
    return _weighted(seed, key, index, field.key, ordered_skew(field.options))


# Dates. Each child takes its parent's date, a few working days later, never after today.


@lru_cache(maxsize=65_536)
def _visit_day(module_key: str, index: int, seed: int, anchor: date, frozen: Counts) -> date:
    counts = dict(frozen)
    open_visit = ledger.open_visit(module_key, index, seed, counts)
    status = ledger.status_label(module_key, index, seed, counts)
    booked = module_key == "appointments" and status in {"Booked", "Waitlist"}
    return dates.visit_date(module_key, index, seed, anchor, counts, open_visit=open_visit,
                            booked=booked)  # fmt: skip


def visit_day(module_key: str, index: int, seed: int, anchor: date, counts: Mapping[str, int]
              ) -> date:  # fmt: skip
    return _visit_day(module_key, index, seed, anchor, _frozen(counts))


@lru_cache(maxsize=65_536)
def _specimen_day(index: int, seed: int, anchor: date, frozen: Counts) -> date:
    counts = dict(frozen)
    ordered = max(
        visit_day("encounters", links.order_encounter(order, counts), seed, anchor, counts)
        for order in links.specimen_orders(index, counts)
    )
    return dates.after(ordered, f"{seed}:specimens:{index}:collected", 0, 1, anchor)


def _claim_submitted(claim: int, seed: int, anchor: date, counts: Mapping[str, int]) -> date:
    service = visit_day("encounters", links.claim_encounter(claim, counts), seed, anchor, counts)
    return dates.after(service, f"{seed}:claims:{claim}:submitted", 1, 3, anchor)


def _request_day(request: int, seed: int, anchor: date) -> date:
    return dates.activity_date("purchase_requests", request, seed, anchor, {})


def _main(module_key: str, field_key: str, index: int, seed: int, anchor: date,
          counts: Mapping[str, int], status: str) -> date | None:  # fmt: skip
    key = f"{seed}:{module_key}:{index}:{field_key}"
    if module_key in {"appointments", "encounters"}:
        return visit_day(module_key, index, seed, anchor, counts)
    if module_key == "orders":
        return visit_day("encounters", links.order_encounter(index, counts), seed, anchor, counts)
    if module_key == "prescriptions":
        encounter = links.prescription_encounter(index, counts)
        return visit_day("encounters", encounter, seed, anchor, counts)
    if module_key == "specimens":
        return _specimen_day(index, seed, anchor, _frozen(counts))
    if module_key == "lab_results":
        specimen = links.result_slot(index, counts)[0]
        collected = _specimen_day(specimen, seed, anchor, _frozen(counts))
        return dates.after(collected, key, 0, 2, anchor)
    if module_key in {"lab_qc_runs", "temperature_logs"}:
        return dates.daily_date(module_key, index, anchor, counts)
    if module_key == "dispenses":
        prescription = links.dispense_prescription(index, counts)
        written = _main("prescriptions", "prescribed_on", prescription, seed, anchor, counts, "")
        return dates.after(written or anchor, key, 0, 2, anchor)
    if module_key == "claims":
        if field_key == "submitted_on":
            return None if status == "Draft" else _claim_submitted(index, seed, anchor, counts)
        return visit_day("encounters", links.claim_encounter(index, counts), seed, anchor, counts)
    if module_key == "claim_responses":
        claim = links.response_claim(index, counts)
        decided = dates.after(_claim_submitted(claim, seed, anchor, counts), key + ":1", 10, 28,
                              anchor)  # fmt: skip
        if links.second_response(index, counts):
            return dates.after(decided, key + ":2", 7, 21, anchor)
        return decided
    if module_key == "payments":
        remitted = links.payment_claim(index, counts)
        if remitted is None:
            encounter = links.copay_encounter(index, counts)
            return visit_day("encounters", encounter, seed, anchor, counts)
        return dates.after(_claim_submitted(remitted, seed, anchor, counts), key, 14, 35, anchor)
    if module_key == "coverages" and field_key == "valid_to":
        if status != "Cancelled":
            return None
        start = dates.activity_date(module_key, index, seed, anchor, counts)
        return dates.after(start, key, 60, 300, anchor - timedelta(days=1))
    if module_key == "purchase_requests" and field_key == "needed_by":
        requested = _request_day(index, seed, anchor)
        return dates.clinic_day(requested + timedelta(days=7 + index % 15), anchor)
    if module_key == "purchase_orders":
        requests = links.order_requests(index, counts)
        ordered = (dates.after(max(_request_day(item, seed, anchor) for item in requests),
                               key + ":order", 1, 5, anchor) if requests
                   else dates.activity_date(module_key, index, seed, anchor, counts))  # fmt: skip
        if field_key == "expected_delivery":
            return dates.clinic_day(ordered + timedelta(days=3 + index % 12), anchor)
        return ordered
    if module_key == "maintenance_work_orders":
        done = status in {"Completed", "In progress", "Awaiting parts", "Cancelled"}
        scheduled = dates.pick(module_key, index, seed, anchor,
                               (-dates.SPAN, -1) if done else (1, 21))  # fmt: skip
        if field_key == "completed_on":
            return dates.after(scheduled, key, 0, 3, anchor) if status == "Completed" else None
        return scheduled
    if module_key == "incident_reports" and index == 0:
        return dates.daily_date("temperature_logs", 0, anchor, counts)
    if module_key == "staff_credentials" and status == "Pending verification":
        return None
    return dates.activity_date(module_key, index, seed, anchor, counts)


def timeline_date(
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
    status: str,
) -> str | object:
    day = _main(module.key, field.key, index, seed, anchor, counts, status)
    if day is None:
        return OMIT
    if field.type == "Date":
        return day.isoformat()
    key = f"{seed}:{module.key}:{index}:{field.key}"
    if module.key == "appointments":
        return dates.stamp(day, dates.visit_time(module.key, index, seed))
    if module.key == "encounters":
        appointment = links.encounter_appointment(index, counts)
        if appointment is None:
            return dates.entry_stamp(day, key)
        booked = dates.visit_time("appointments", appointment, seed)
        minutes = booked.hour * 60 + booked.minute + 5 + index % 20
        return dates.stamp(day, time(minutes // 60, minutes % 60))
    if module.key == "temperature_logs":
        hour, minute = (7, 30) if index % 2 == 0 else (16, 0)
        return dates.stamp(day, time(hour, minute + (index * 7) % 30))
    if module.key == "specimens":
        return dates.stamp(day, time(7 + index % 8, (index * 11) % 60))
    return dates.entry_stamp(day, key)
