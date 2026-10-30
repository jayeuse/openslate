"""Clinic relationship rules. Every link is planned from record indexes and counts only.

A record's status, dates and amounts that a link depends on (a fulfilled appointment, a
paid claim) are drawn from the same index rules here, so the two sides always agree.
"""

from __future__ import annotations

import random
from collections.abc import Mapping
from functools import lru_cache

from operations.sample.packs.clinic.realism import (
    CLAIM_CLASSES,
    DECIDED_CLASSES,
    PAID_CLASSES,
)
from operations.sample.realism import skewed_parent, weighted_label

# Records below this index carry named business cases; the realism rules leave them alone.
PINNED = 10

# Typed codes that repeat a link the department already has as a relationship.
REFERENCE_FIELDS = (("dispenses", "lot_reference"), ("payments", "claim_reference"))

# The named follow-ups: a claim for visit 5, a reorder for lot 5, a repair for device 5.
CLAIM_VISIT = 4
REPAIR_DEVICE = 4
SELF_PAY_VISIT = 2  # The open visit that the claim rule's live input finishes.


def _counts_key(counts: Mapping[str, int], *keys: str) -> tuple[int, ...]:
    return tuple(counts[key] for key in keys)


# Patient Access and Clinical Services.


def walk_in(encounter: int) -> bool:
    """About one visit in seven has no appointment (research §7: 15% walk-ins)."""
    return encounter >= PINNED and encounter % 7 == 6


def encounter_appointment(encounter: int, counts: Mapping[str, int]) -> int | None:
    if walk_in(encounter):
        return None
    appointment = encounter if encounter < PINNED else encounter - (encounter // 7 - 1)
    return appointment if appointment < counts["appointments"] else None


@lru_cache(maxsize=16)
def _appointment_visits(encounters: int, appointments: int) -> dict[int, int]:
    counts = {"encounters": encounters, "appointments": appointments}
    visits = {}
    for encounter in range(encounters):
        appointment = encounter_appointment(encounter, counts)
        if appointment is not None:
            visits[appointment] = encounter
    return visits


def appointment_encounter(appointment: int, counts: Mapping[str, int]) -> int | None:
    return _appointment_visits(*_counts_key(counts, "encounters", "appointments")).get(appointment)


def appointment_patient(appointment: int, counts: Mapping[str, int]) -> int:
    return skewed_parent("patient_appointments", appointment, counts["patients"], alpha=0.5)


def encounter_patient(encounter: int, counts: Mapping[str, int]) -> int:
    appointment = encounter_appointment(encounter, counts)
    if appointment is not None:
        return appointment_patient(appointment, counts)
    return skewed_parent("walk_in_patients", encounter, counts["patients"])


def coverage_patient(coverage: int, counts: Mapping[str, int]) -> int:
    """Insured patients hold the first coverages; the others pay for themselves."""
    return coverage % counts["patients"]


def patient_coverage(patient: int, counts: Mapping[str, int]) -> int | None:
    return patient if patient < counts["coverages"] else None


def coverage_payer(coverage: int, counts: Mapping[str, int]) -> int:
    return skewed_parent("payer_coverages", coverage, counts["payers"], alpha=1.0)


def billable(encounter: int, counts: Mapping[str, int]) -> bool:
    """A visit is billed to a payer when its patient has a coverage on file."""
    if encounter == SELF_PAY_VISIT:
        return False
    return patient_coverage(encounter_patient(encounter, counts), counts) is not None


@lru_cache(maxsize=16)
def _billable(encounters: int, appointments: int, patients: int, coverages: int) -> tuple[int, ...]:
    counts = {"encounters": encounters, "appointments": appointments, "patients": patients,
              "coverages": coverages}  # fmt: skip
    return tuple(item for item in range(encounters) if billable(item, counts))


def _billable_list(counts: Mapping[str, int]) -> tuple[int, ...]:
    return _billable(*_counts_key(counts, "encounters", "appointments", "patients", "coverages"))


def claim_encounter(claim: int, counts: Mapping[str, int]) -> int:
    if claim == 0:
        return CLAIM_VISIT
    visits = _billable_list(counts)
    return visits[claim % len(visits)]


@lru_cache(maxsize=16)
def _claimed(key: tuple[int, ...]) -> frozenset[int]:
    counts = dict(zip(("encounters", "appointments", "patients", "coverages", "claims"), key,
                      strict=True))  # fmt: skip
    return frozenset(claim_encounter(claim, counts) for claim in range(counts["claims"]))


def encounter_claimed(encounter: int, counts: Mapping[str, int]) -> bool:
    key = _counts_key(counts, "encounters", "appointments", "patients", "coverages", "claims")
    return encounter in _claimed(key)


def claim_patient(claim: int, counts: Mapping[str, int]) -> int:
    return encounter_patient(claim_encounter(claim, counts), counts)


def claim_coverage(claim: int, counts: Mapping[str, int]) -> int | None:
    return patient_coverage(claim_patient(claim, counts), counts)


# Revenue Cycle: a claim's outcome class decides its response and payer payment.


def claim_class(claim: int) -> str:
    if claim == 0:
        return "Partially paid"
    if claim == 1:
        return "Paid"
    if claim == 2:
        return "Submitted"  # The live input denies it, which fills the denials queue.
    return weighted_label(random.Random(f"clinic:claim-class:{claim}"), CLAIM_CLASSES)


@lru_cache(maxsize=16)
def _claim_lists(claims: int) -> tuple[tuple[int, ...], tuple[int, ...], tuple[int, ...]]:
    classes = [claim_class(claim) for claim in range(claims)]
    paid = tuple(claim for claim, label in enumerate(classes) if label in PAID_CLASSES)
    decided = tuple(claim for claim, label in enumerate(classes) if label in DECIDED_CLASSES)
    fully_paid = tuple(claim for claim, label in enumerate(classes) if label == "Paid")
    return paid, decided, fully_paid


def remittance_count(counts: Mapping[str, int]) -> int:
    return min(counts["payments"], len(_claim_lists(counts["claims"])[0]))


def payment_claim(payment: int, counts: Mapping[str, int]) -> int | None:
    """The first payments are payer remittances, one for each paid claim; the rest are copays."""
    paid = _claim_lists(counts["claims"])[0]
    return paid[payment] if payment < remittance_count(counts) else None


def payment_patient(payment: int, counts: Mapping[str, int]) -> int:
    claim = payment_claim(payment, counts)
    if claim is not None:
        return claim_patient(claim, counts)
    return encounter_patient(copay_encounter(payment, counts), counts)


def copay_encounter(payment: int, counts: Mapping[str, int]) -> int:
    return (payment - remittance_count(counts)) * 3 % counts["encounters"]


def response_claim(response: int, counts: Mapping[str, int]) -> int:
    """First decisions in claim order, then second decisions on claims paid after appeal."""
    _paid, decided, fully_paid = _claim_lists(counts["claims"])
    if response < len(decided):
        return decided[response]
    return fully_paid[(response - len(decided)) % len(fully_paid)]


def first_decision_reversed(claim: int, counts: Mapping[str, int]) -> bool:
    """A paid claim with a second response was denied first and paid on resubmission."""
    _paid, decided, fully_paid = _claim_lists(counts["claims"])
    extra = max(0, counts["claim_responses"] - len(decided))
    return claim in {fully_paid[step % len(fully_paid)] for step in range(extra)}


def second_response(response: int, counts: Mapping[str, int]) -> bool:
    return response >= len(_claim_lists(counts["claims"])[1])


# Laboratory: tubes serve one or two lab orders; results follow the tubes.


def order_category(order: int) -> str:
    if order >= PINNED and order % 10 == 9:
        return "Imaging"
    if order >= PINNED and order % 31 == 17:
        return "Procedure"
    return "Laboratory"


@lru_cache(maxsize=16)
def _lab_orders(orders: int) -> tuple[int, ...]:
    return tuple(order for order in range(orders) if order_category(order) == "Laboratory")


def specimen_orders(specimen: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    lab = _lab_orders(counts["orders"])
    start = specimen + (specimen + 2) // 3
    positions = (start, start + 1) if specimen % 3 == 0 else (start,)
    return tuple(dict.fromkeys(lab[position % len(lab)] for position in positions))


def specimen_pending(specimen: int) -> bool:
    """Some tubes are still in the lab or were rejected, so they have no result yet."""
    return specimen >= PINNED and specimen % 12 == 7


@lru_cache(maxsize=16)
def _result_slots(specimens: int, orders: int) -> tuple[tuple[int, int], ...]:
    counts = {"specimens": specimens, "orders": orders}
    return tuple(
        (specimen, order)
        for specimen in range(specimens)
        if not specimen_pending(specimen)
        for order in specimen_orders(specimen, counts)
    )


def result_slot(result: int, counts: Mapping[str, int]) -> tuple[int, int]:
    slots = _result_slots(counts["specimens"], counts["orders"])
    return slots[result % len(slots)]


def amended_result(result: int, counts: Mapping[str, int]) -> bool:
    return result >= len(_result_slots(counts["specimens"], counts["orders"]))


def order_encounter(order: int, counts: Mapping[str, int]) -> int:
    return skewed_parent("encounter_orders", order, counts["encounters"], alpha=0.4)


def prescription_encounter(prescription: int, counts: Mapping[str, int]) -> int:
    return skewed_parent(
        "encounter_prescriptions", prescription, counts["encounters"], alpha=0.4
    )


# Pharmacy: lots of each item, and fills from the lot of the prescribed item.


def lot_item(lot: int, counts: Mapping[str, int]) -> int:
    return skewed_parent("item_stock_lots", lot, counts["pharmacy_items"])


@lru_cache(maxsize=16)
def _item_lots(lots: int, items: int) -> dict[int, tuple[int, ...]]:
    counts = {"stock_lots": lots, "pharmacy_items": items}
    found: dict[int, list[int]] = {}
    for lot in range(lots):
        found.setdefault(lot_item(lot, counts), []).append(lot)
    return {item: tuple(values) for item, values in found.items()}


def prescription_item(prescription: int, counts: Mapping[str, int]) -> int:
    stocked = sorted(_item_lots(counts["stock_lots"], counts["pharmacy_items"]))
    if prescription < PINNED:
        return stocked[prescription % len(stocked)]
    rng = random.Random(f"clinic:rx-item:{prescription}")
    weights = [(rank + 1) ** -0.6 for rank in range(len(stocked))]
    return rng.choices(stocked, weights=weights)[0]


def filled_in_house(prescription: int) -> bool:
    return prescription % 5 < 3  # About 60% of prescriptions (research §3).


@lru_cache(maxsize=16)
def _in_house(prescriptions: int) -> tuple[int, ...]:
    return tuple(item for item in range(prescriptions) if filled_in_house(item))


def dispense_prescription(dispense: int, counts: Mapping[str, int]) -> int:
    filled = _in_house(counts["prescriptions"])
    return filled[dispense % len(filled)]


def dispense_lot(dispense: int, counts: Mapping[str, int]) -> int:
    item = prescription_item(dispense_prescription(dispense, counts), counts)
    lots = _item_lots(counts["stock_lots"], counts["pharmacy_items"])[item]
    return lots[dispense % len(lots)]


# Operations: the refrigerators and analyzers come first in the equipment list.


def fridge_count(counts: Mapping[str, int]) -> int:
    return max(2, round(counts["temperature_logs"] / 128))


def analyzer_count(counts: Mapping[str, int]) -> int:
    return max(1, round(counts["lab_qc_runs"] / 192))


def log_fridge(log: int, counts: Mapping[str, int]) -> int:
    return (log // 2) % fridge_count(counts)


def qc_analyzer(run: int, counts: Mapping[str, int]) -> int:
    return fridge_count(counts) + (run // 3) % analyzer_count(counts)


def request_converted(request: int) -> bool:
    return request != 0 and request % 10 not in {3, 6, 8}


@lru_cache(maxsize=16)
def _converted(requests: int) -> tuple[int, ...]:
    return tuple(item for item in range(requests) if request_converted(item))


def order_requests(order: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    converted = _converted(counts["purchase_requests"])
    if not converted:
        return ()
    picks = [converted[order % len(converted)]]
    if order % 4 == 3:
        picks.append(converted[(order + len(converted) // 2) % len(converted)])
    return tuple(dict.fromkeys(picks))


def incident_equipment(incident: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    if incident == 0:
        return (0,)  # The vaccine refrigerator of the excursion.
    if incident >= PINNED and incident % 6 == 1:
        return (skewed_parent("incident_equipment", incident, counts["equipment"]),)
    return ()


def parent_indices(key: str, target: int, counts: Mapping[str, int]) -> tuple[int, ...]:
    """The parents one child record links to; for a link to another department the child is
    the record that names the other one."""
    if key == "patient_coverages":
        return (coverage_patient(target, counts),)
    if key == "payer_coverages":
        return (coverage_payer(target, counts),)
    if key == "patient_appointments":
        return (appointment_patient(target, counts),)
    if key == "encounter_orders":
        return (order_encounter(target, counts),)
    if key == "encounter_prescriptions":
        return (prescription_encounter(target, counts),)
    if key == "specimen_results":
        return (result_slot(target, counts)[0],)
    if key == "result_order":
        return (result_slot(target, counts)[1],)
    if key == "item_stock_lots":
        return (lot_item(target, counts),)
    if key == "lot_dispenses":
        return (dispense_lot(target, counts),)
    if key == "claim_responses":
        return (response_claim(target, counts),)
    if key == "claim_payments":
        claim = payment_claim(target, counts)
        return () if claim is None else (claim,)
    if key == "supplier_purchase_orders":
        return (skewed_parent(key, target, counts["suppliers"]),)
    if key == "request_orders":
        return order_requests(target, counts)
    if key == "equipment_work_orders":
        if target == 0:
            return (REPAIR_DEVICE,)
        return (skewed_parent(key, target, counts["equipment"]),)
    if key == "encounter_appointment":
        appointment = encounter_appointment(target, counts)
        return () if appointment is None else (appointment,)
    if key == "encounter_patient":
        return (encounter_patient(target, counts),)
    if key == "specimen_orders":
        return specimen_orders(target, counts)
    if key == "qc_run_analyzer":
        return (qc_analyzer(target, counts),)
    if key == "dispense_prescription":
        return (dispense_prescription(target, counts),)
    if key == "temperature_log_unit":
        return (log_fridge(target, counts),)
    if key == "claim_encounter":
        return (claim_encounter(target, counts),)
    if key == "claim_coverage":
        coverage = claim_coverage(target, counts)
        return () if coverage is None else (coverage,)
    if key == "payment_patient":
        return (payment_patient(target, counts),)
    if key == "incident_equipment":
        return incident_equipment(target, counts)
    if key == "incident_temperature_log":
        return (0,) if target == 0 else ()
    raise ValueError("Unknown Clinic relationship")


def reference_parents(
    module_key: str, field_key: str, index: int, counts: Mapping[str, int]
) -> tuple[tuple[str, int], ...]:
    """The records in the same department that a field's visible code names."""
    if (module_key, field_key) == ("dispenses", "lot_reference"):
        return (("stock_lots", dispense_lot(index, counts)),)
    if (module_key, field_key) == ("payments", "claim_reference"):
        claim = payment_claim(index, counts)
        return () if claim is None else (("claims", claim),)
    raise ValueError("Unknown Clinic reference field")
