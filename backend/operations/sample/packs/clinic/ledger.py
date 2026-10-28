"""Clinic record states and money: statuses, claim amounts, payer payments and copays.

Statuses that a link depends on follow the index rules in ``links``; the others are
drawn from the pack's weights (spec R1). Named cases below index ``PINNED`` stay exact.
"""

from __future__ import annotations

import random
from collections.abc import Mapping
from functools import lru_cache

from operations.sample.packs.clinic import links
from operations.sample.packs.clinic.links import PINNED
from operations.sample.packs.clinic.realism import (
    APPOINTMENT_UNSEEN,
    CHARGE,
    COPAY_TIERS,
    ENCOUNTER_OPEN,
    PAID_CLASSES,
    SPECIMEN_PENDING,
    STATUS_WEIGHTS,
)
from operations.sample.realism import long_tail_amount, weighted_label

# Statuses of the named cases: live trigger inputs, follow-ups and refusal targets.
_PINNED_STATUS: dict[tuple[str, int], str] = {
    ("encounters", links.SELF_PAY_VISIT): "In progress",
    ("encounters", links.CLAIM_VISIT): "Finished",
    ("lab_results", 0): "Final",
    ("lab_results", 1): "Preliminary",
    ("stock_lots", 2): "Available",
    ("stock_lots", 4): "Available",
    ("temperature_logs", 0): "Excursion resolved",
    ("equipment", 3): "In service",
    ("equipment", links.REPAIR_DEVICE): "Out of service",
    ("maintenance_work_orders", 0): "Open",
    ("incident_reports", 0): "Action plan",
    ("incident_reports", 1): "Under review",
    ("purchase_requests", 0): "Submitted",
    ("payments", 0): "Posted",
    ("staff_credentials", 0): "Verified",
}


def _draw(module_key: str, index: int, seed: int, weights: Mapping[str, float]) -> str:
    return weighted_label(random.Random(f"{seed}:{module_key}:{index}:status"), weights)


def encounter_status(index: int, seed: int, counts: Mapping[str, int]) -> str:
    pinned = _PINNED_STATUS.get(("encounters", index))
    if pinned is not None:
        return pinned
    if index < PINNED or links.encounter_claimed(index, counts):
        return "Finished"
    rng = random.Random(f"{seed}:encounters:{index}:open")
    return weighted_label(rng, ENCOUNTER_OPEN) if rng.random() < 0.1 else "Finished"


def appointment_status(index: int, seed: int, counts: Mapping[str, int]) -> str:
    encounter = links.appointment_encounter(index, counts)
    if encounter is None:
        return _draw("appointments", index, seed, APPOINTMENT_UNSEEN)
    visit = encounter_status(encounter, seed, counts)
    if visit == "Finished":
        return "Fulfilled"
    if visit in {"Cancelled", "Entered in error"}:
        return visit
    return "Checked in" if visit in {"In progress", "Triaged"} else "Arrived"


def open_visit(module_key: str, index: int, seed: int, counts: Mapping[str, int]) -> bool:
    """A visit still under way today: its appointment is checked in, not yet fulfilled."""
    if module_key == "appointments":
        encounter = links.appointment_encounter(index, counts)
        if encounter is None:
            return False
        index = encounter
    return encounter_status(index, seed, counts) in {"Arrived", "Triaged", "In progress"}


def status_label(module_key: str, index: int, seed: int, counts: Mapping[str, int]) -> str:
    return _status_label(module_key, index, seed, tuple(sorted(counts.items())))


@lru_cache(maxsize=131_072)
def _status_label(
    module_key: str, index: int, seed: int, frozen: tuple[tuple[str, int], ...]
) -> str:
    counts = dict(frozen)
    pinned = _PINNED_STATUS.get((module_key, index))
    if pinned is not None:
        return pinned
    if module_key == "appointments":
        return appointment_status(index, seed, counts)
    if module_key == "encounters":
        return encounter_status(index, seed, counts)
    if module_key == "claims":
        return links.claim_class(index)
    if module_key == "specimens":
        if links.specimen_pending(index):
            return _draw(module_key, index, seed, SPECIMEN_PENDING)
        return "Available"
    if module_key == "lab_results":
        if links.amended_result(index, counts):
            return ("Amended", "Corrected")[index % 2]
        return _draw(module_key, index, seed, {"Final": 90, "Preliminary": 8, "Cancelled": 2})
    if module_key == "purchase_requests":
        if links.request_converted(index):
            return "Converted to PO"
        weights = {"Approved": 33, "Submitted": 27, "Rejected": 23, "Cancelled": 17}
        return _draw(module_key, index, seed, weights)
    if index < PINNED:
        return next(iter(STATUS_WEIGHTS[module_key]))
    return _draw(module_key, index, seed, STATUS_WEIGHTS[module_key])


# Money. Claim amounts do not use the seed: payments and responses in other records
# repeat them, so both sides must agree for every run.


def charge_total(claim: int) -> int | float:
    if claim == 0:
        return 420
    if claim < PINNED:
        return 150 + (claim * 97) % 400
    return long_tail_amount(random.Random(f"clinic:charge:{claim}"), CHARGE)


def copay(coverage: int) -> int:
    rng = random.Random(f"clinic:copay:{coverage}")
    return rng.choices(COPAY_TIERS, weights=(8, 22, 26, 20, 12, 9, 3))[0]


def _cents(value: float) -> int | float:
    value = round(value, 2)
    return int(value) if float(value).is_integer() else value


def allowed_amount(claim: int) -> int | float:
    if claim == 0:
        return 360
    ratio = random.Random(f"clinic:allowed:{claim}").uniform(0.55, 0.85)
    return _cents(float(charge_total(claim)) * ratio)


def patient_share(claim: int, counts: Mapping[str, int]) -> int | float:
    if claim == 0:
        return 60
    coverage = links.claim_coverage(claim, counts)
    share = 0 if coverage is None else copay(coverage)
    return _cents(min(float(allowed_amount(claim)), share))


def payer_paid(claim: int, counts: Mapping[str, int]) -> int | float:
    """What the payer remitted: the allowed amount less the patient's share, or part of it."""
    if claim == 0:
        return 300
    if links.claim_class(claim) not in PAID_CLASSES:
        return 0
    due = float(allowed_amount(claim)) - float(patient_share(claim, counts))
    if links.claim_class(claim) == "Partially paid":
        due *= random.Random(f"clinic:partial:{claim}").uniform(0.4, 0.8)
    return _cents(max(0.0, due))


def claim_balance(claim: int, counts: Mapping[str, int]) -> int | float:
    return _cents(float(charge_total(claim)) - float(payer_paid(claim, counts)))


def payment_amount(payment: int, seed: int, counts: Mapping[str, int]) -> int | float:
    claim = links.payment_claim(payment, counts)
    if claim is not None:
        return payer_paid(claim, counts)
    rng = random.Random(f"{seed}:payments:{payment}:copay")
    patient = links.payment_patient(payment, counts)
    coverage = links.patient_coverage(patient, counts)
    if coverage is not None and copay(coverage) > 0 and rng.random() < 0.8:
        return copay(coverage)
    # A self-pay visit, or a balance paid after the payer's share.
    return _cents(rng.choice((85, 95, 110, 125, 150, 175, 200)) * rng.choice((1, 1, 1, 0.5)))
