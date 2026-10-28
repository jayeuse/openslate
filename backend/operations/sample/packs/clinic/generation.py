"""Deterministic clinic record values, including the named claim part-payment."""

from __future__ import annotations

import random
from collections.abc import Mapping
from datetime import date

from operations.sample.actors import assignee_key
from operations.sample.blueprint import (
    NamedCalculationCheck,
    NamedFieldCheck,
    NamedRelationshipCheck,
    NamedScenario,
    _option_id,
)
from operations.sample.packs.clinic import dates, ledger, links, text, vocabulary
from operations.sample.packs.clinic.links import PINNED
from operations.sample.packs.clinic.realism import LOT_COST, PACK_PRICE, PO_TOTAL, WO_COST
from operations.sample.packs.clinic.values import (
    choice_label,
    em_code,
    lot_months,
    result_flag,
    timeline_date,
)
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.types import OMIT, FieldSpec, JsonValue, ModuleSpec
from operations.sample.realism import DIRT, dirty_text, dirty_value, long_tail_amount

NAMED_SCENARIOS = (
    NamedScenario(
        key="claim-part-payment",
        name="Payer part payment on a visit claim",
        record_ids=("claims:000001", "payments:000001"),
        expected={"charge_total": 420, "payment_amount": 300, "balance": 120},
        field_checks=(
            NamedFieldCheck("claims:000001", "charge_total", "charge_total"),
            NamedFieldCheck("claims:000001", "balance", "balance"),
            NamedFieldCheck("payments:000001", "amount", "payment_amount"),
        ),
        relationship_checks=(
            NamedRelationshipCheck("claim_payments", "claims:000001", "payments:000001"),
        ),
        calculation_checks=(
            NamedCalculationCheck("balance", "subtract", ("charge_total", "payment_amount")),
        ),
    ),
)

_PROVIDERS = ("internal_clinical_lead", "internal_clinical_02")
_VALIDATORS = {"laboratory": ("internal_laboratory_lead", "internal_laboratory_02"),
               "pharmacy": ("internal_pharmacy_lead", "internal_pharmacy_02")}  # fmt: skip
_REQUESTERS = ("internal_clinical_03", "internal_clinical_04", "internal_pharmacy_03",
               "internal_laboratory_lead", "internal_pharmacy_lead")  # fmt: skip


def _user(key: str) -> str:
    return f"@user:{key}"


def _rng(seed: int, module: ModuleSpec, field: FieldSpec, index: int) -> random.Random:
    return random.Random(f"{seed}:{module.key}:{index}:{field.key}:clinic")


def _complaint(encounter: int, seed: int) -> tuple[str, str, bool]:
    rng = random.Random(f"{seed}:encounters:{encounter}:complaint")
    weights = [(rank + 1) ** -0.5 * (1.4 if flu else 1.0)
               for rank, (_c, _code, flu) in enumerate(vocabulary.COMPLAINTS)]  # fmt: skip
    return rng.choices(vocabulary.COMPLAINTS, weights=weights)[0]


def _amount(module: ModuleSpec, index: int, seed: int, kind: str) -> int | float:
    shapes = {"pack_price": PACK_PRICE, "unit_cost": LOT_COST, "po_total": PO_TOTAL,
              "wo_cost": WO_COST}  # fmt: skip
    if index < PINNED:
        return {"pack_price": 12, "unit_cost": 8, "po_total": 1_250, "wo_cost": 150}[kind] + index
    return long_tail_amount(random.Random(f"{seed}:{module.key}:{index}:{kind}"), shapes[kind])


def _temperature(module_key: str, index: int, status: str, kind: str) -> float:
    rng = random.Random(f"clinic:{module_key}:{index}:temperature")
    current = round(rng.uniform(3.2, 6.4), 1)
    if index == 0:
        current = 5.1
    low = round(max(2.1, current - rng.uniform(0.3, 1.1)), 1)
    high = round(min(7.9, current + rng.uniform(0.3, 1.3)), 1)
    if status != "In range":
        high = 9.4 if index == 0 else round(rng.uniform(8.3, 10.2), 1)
        if status == "Excursion":
            current = round(rng.uniform(8.1, 8.9), 1)
    return {"current_temperature": current, "min_temperature": low, "max_temperature": high}[kind]


def _qty_on_hand(index: int, status: str) -> int:
    if index == 2:
        return 60  # The live input lowers it below the reorder threshold.
    if index == 4:
        return 15  # History lowers it from 40, which flags the reorder follow-up.
    if status == "Depleted":
        return 0
    rng = random.Random(f"clinic:lot-qty:{index}")
    return rng.randint(20, 400) if status == "Available" else rng.randint(4, 120)


def _response_amount(response: int, kind: str, counts: Mapping[str, int]) -> int | float:
    claim = links.response_claim(response, counts)
    first_denial = links.first_decision_reversed(claim, counts) and not links.second_response(
        response, counts
    )
    if links.claim_class(claim) not in {"Paid", "Partially paid"} or first_denial:
        return 0
    if kind == "allowed_amount":
        return ledger.allowed_amount(claim)
    if kind == "patient_share":
        return ledger.patient_share(claim, counts)
    return ledger.payer_paid(claim, counts)


def _clean_field_value(
    organization: OrganizationPack,
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> JsonValue | object:
    kind = field.value_kind
    key = module.key
    status = ledger.status_label(key, index, seed, counts)

    def rng() -> random.Random:
        return _rng(seed, module, field, index)

    if kind == "status":
        if status == field.default_value and index % 5 == 0:
            return OMIT
        return _option_id(seed, key, field.key, status, organization)
    if field.type == "Select":
        label = choice_label(module, field, index, seed, anchor, counts, status)
        return OMIT if label is None else _option_id(seed, key, field.key, label, organization)
    if kind == "title":
        return text.record_title(key, index, seed, counts)
    if kind == "reference":
        return text.reference_code(key, index, seed) or OMIT
    if kind == "cross_reference":
        parents = links.reference_parents(key, field.key, index, counts)
        if not parents:
            return OMIT
        target, target_index = parents[0]
        if target == "stock_lots":
            return text.lot_number(target_index)
        return text.reference_code(target, target_index, seed) or OMIT
    if kind == "owner":
        return _user(assignee_key(key, module.department, index, seed, organization))
    if kind == "provider":
        return _user(_PROVIDERS[(index * 3 + seed) % 2] if index >= PINNED else _PROVIDERS[0])
    if kind == "validator":
        if status not in {"Final", "Amended", "Corrected", "Completed"}:
            return OMIT
        return _user(_VALIDATORS[module.department][(index + seed) % 2])
    if kind == "requester":
        return _user(_REQUESTERS[(index * 7 + seed) % len(_REQUESTERS)])
    if kind == "approver":
        if key == "purchase_requests" and status in {"Draft", "Submitted"}:
            return OMIT
        return _user("internal_operations_lead")
    if kind == "flag":
        return False
    if kind == "boolean":
        if field.key == "invoice_matched":
            return status in {"Received", "Closed"}
        if field.key == "privileges_active":
            return status not in {"Expired", "Suspended", "Revoked", "Pending verification"}
        if field.key == "cold_chain":
            return text.item(index)[3]
        return rng().random() < (0.85 if field.key in {"sms_consent", "licensed",
                                                    "source_verified"} else 0.3)  # fmt: skip
    if kind == "notes":
        if index % 9 == 0 and index:
            return ""
        return text.note_text(key, field.key, index, seed)
    if kind in {"mrn"}:
        return text.reference_code("patients", index, seed) or OMIT
    if kind == "given_name":
        return text.patient_names(index, seed)[0]
    if kind == "family_name":
        return text.patient_names(index, seed)[1]
    if kind == "birth_date":
        return dates.birth_date(index, seed, anchor).isoformat()
    if kind == "phone":
        return text.phone_value(index, seed)
    if kind == "email":
        if key == "patients" and rng().random() < 0.35:
            return OMIT  # Many patients give no email address.
        return text.email_value(key, index, seed, counts)
    if kind == "url":
        return text.url_value(key, index, seed)
    if kind == "city":
        return vocabulary.CITIES[(index * 3 + seed) % len(vocabulary.CITIES)]
    if kind == "member_id":
        payer_code = text.payer(links.coverage_payer(index, counts))[2]
        return f"{payer_code[:3]}{(index * 7_919 + 40_113) % 10**8:08d}"
    if kind == "plan_name":
        suffix = vocabulary.PLAN_SUFFIXES[index % len(vocabulary.PLAN_SUFFIXES)]
        return f"{text.payer(links.coverage_payer(index, counts))[0]} {suffix}"
    if kind == "copay_amount":
        return ledger.copay(index)
    if kind == "payer_id":
        return text.payer(index)[2]
    if kind == "filing_limit":
        payer_type = text.payer(index)[1]
        return {"Medicare": 365, "Medicaid managed care": 180, "Employer account": 365}.get(
            payer_type, (90, 180)[index % 2]
        )
    if kind == "duration":
        return rng().choice((15, 15, 20, 20, 30, 30, 40, 60))
    if field.type == "Date" or field.type == "Date/Time":
        return timeline_date(module, field, index, seed, anchor, counts, status)
    if kind == "chief_complaint":
        return _complaint(index, seed)[0]
    if kind == "diagnosis":
        encounter = {
            "encounters": index,
            "orders": links.order_encounter(index, counts),
            "claims": links.claim_encounter(index, counts),
        }[key]
        return _complaint(encounter, seed)[1]
    if kind == "procedure_codes":
        visit = em_code(links.claim_encounter(index, counts), seed)
        return f"{visit}; 36415" if rng().random() < 0.4 else visit
    if kind == "bp_systolic":
        return rng().randint(104, 162)
    if kind == "bp_diastolic":
        return rng().randint(62, 98)
    if kind == "temperature":
        fever = "Fever" in _complaint(index, seed)[0]
        return round(rng().uniform(100.4, 102.6) if fever else rng().uniform(97.2, 99.3), 1)
    if kind == "order_service":
        return text.order_service(index)
    if kind == "medication":
        generic, strength, form, _cold = text.item(links.prescription_item(index, counts))
        return f"{generic} {strength} {form.lower()}"
    if kind == "rx_quantity":
        if key == "dispenses":
            prescription = links.dispense_prescription(index, counts)
            return _rx_quantity(prescription)
        return _rx_quantity(index)
    if kind == "refills":
        return rng().choice((0, 0, 0, 1, 2, 3, 5))
    if kind == "days_supply":
        return rng().choice((7, 10, 14, 30, 30, 30, 90))
    if kind in {"analyte", "result_value", "units", "reference_range"}:
        return _result_text(kind, index, status, counts) or OMIT
    if kind == "qc_analyte":
        return vocabulary.QC_ANALYTES[(index // 3) % len(vocabulary.QC_ANALYTES)]
    if kind == "qc_note":
        if status == "Passed":
            return OMIT
        return "Repeated with fresh control material; within limits." if status != "Failed" else (
            "Patient runs held; reagent lot changed and calibration repeated."
        )
    if kind == "generic_name":
        return text.item(index)[0]
    if kind == "strength":
        return text.item(index)[1]
    if kind in {"pack_price", "unit_cost", "po_total", "wo_cost"}:
        if kind == "wo_cost" and status not in {"Completed", "Awaiting parts", "In progress"}:
            return OMIT
        return _amount(module, index, seed, kind)
    if kind == "reorder_level":
        return rng().choice((20, 30, 40, 50, 60, 100, 150, 200))
    if kind == "lot_no":
        return text.lot_number(index)
    if kind == "expiry_month":
        months = lot_months(index, status)
        return _month_year(anchor, months)
    if kind == "qty_on_hand":
        return _qty_on_hand(index, status)
    if kind in {"current_temperature", "min_temperature", "max_temperature"}:
        return _temperature(key, index, status, kind)
    if kind == "charge_total":
        return ledger.charge_total(index)
    if kind == "paid_total":
        return ledger.payer_paid(index, counts)
    if kind == "claim_balance":
        return ledger.claim_balance(index, counts)
    if kind == "resubmissions":
        if links.first_decision_reversed(index, counts) or status == "Resubmitted":
            return 1
        return 2 if status == "Appealed" else 0
    if kind in {"allowed_amount", "response_paid", "patient_share"}:
        return _response_amount(index, kind, counts)
    if kind == "payment_amount":
        return ledger.payment_amount(index, seed, counts)
    if kind == "trace_no":
        if links.payment_claim(index, counts) is not None:
            return f"EFT{(index * 104_729 + 7_301) % 10**9:09d}"
        return OMIT if rng().random() < 0.4 else f"AUTH{(index * 3_571) % 10**6:06d}"
    if kind == "lead_time":
        return rng().choice((2, 3, 5, 5, 7, 10, 14, 21))
    if kind == "supply_item":
        return vocabulary.SUPPLY_ITEMS[(index * 5 + seed) % len(vocabulary.SUPPLY_ITEMS)]
    if kind == "supply_quantity":
        return rng().choice((5, 10, 12, 20, 24, 40, 50, 100, 200))
    if kind == "invoice_no":
        return f"INV-{(index * 811 + 50_221) % 10**6:06d}" if status in {
            "Received", "Closed", "Partially received"} else OMIT  # fmt: skip
    if kind == "make_model":
        return _equipment_model(index, counts)
    if kind == "serial":
        return text.serial_value(index, seed)
    if kind == "equipment_location":
        return _equipment_location(index, counts)
    if kind == "technician":
        return ("Northline Biomedical — R. Ibarra", "In-house — D. Pryor",
                "Ridgeway Calibration — T. Moss")[(index + seed) % 3]  # fmt: skip
    if kind == "incident_location":
        places = vocabulary.INCIDENT_LOCATIONS
        return places[(index * 3 + seed) % len(places)]
    if kind == "incident_summary":
        return text.incident(index)[0] + "."
    if kind == "staff_member":
        return text.credential(index)[0]
    if kind == "license_no":
        return f"{('MD', 'RN', 'PH', 'CL', 'BL')[index % 5]}{(index * 6_007 + 31_337) % 10**7:07d}"
    if kind == "credential_expiry":
        months = {"Expired": -1, "Expiring soon": 1}.get(status, 8 + (index * 7) % 30)
        return _month_year(anchor, months)
    raise ValueError(f"Unsupported Clinic field generator {key}.{field.key}")


def _month_year(anchor: date, months: int) -> str:
    """The month a lot or license expires, written as people write it on the label."""
    month = anchor.year * 12 + anchor.month - 1 + months
    return f"{month % 12 + 1:02d}/{month // 12}"


def _rx_quantity(prescription: int) -> int:
    return (30, 90, 14, 21, 28, 60, 30, 10)[prescription % 8]


def _result_text(kind: str, result: int, status: str, counts: Mapping[str, int]) -> str:
    _specimen, order = links.result_slot(result, counts)
    service, analyte, units, reference, _type = text.lab_service(order)
    if kind == "analyte":
        return analyte
    if kind == "units":
        return units
    if kind == "reference_range":
        return reference
    if status == "Cancelled":
        return "Not performed"
    flag = result_flag(result)
    if not units:
        return "Positive" if flag in {"Abnormal", "High"} else reference
    rng = random.Random(f"clinic:result:{result}")
    low, _, high = reference.replace("<", "0–").partition("–")
    base_low, base_high = float(low or 0), float(high or 1)
    value = {"High": base_high * rng.uniform(1.05, 1.4), "Low": base_low * rng.uniform(0.6, 0.95),
             "Critical high": base_high * 1.6, "Critical low": base_low * 0.5}.get(
        flag, rng.uniform(base_low, base_high))  # fmt: skip
    return f"{value:.1f}"


def _equipment_model(index: int, counts: Mapping[str, int]) -> str:
    fridges, analyzers = links.fridge_count(counts), links.analyzer_count(counts)
    if index < fridges:
        return vocabulary.FRIDGE_MODEL
    if index < fridges + analyzers:
        return "Corvane CX-310"
    rest = index - fridges - analyzers
    return vocabulary.EQUIPMENT[rest % len(vocabulary.EQUIPMENT)][2]


def _equipment_location(index: int, counts: Mapping[str, int]) -> str:
    fridges, analyzers = links.fridge_count(counts), links.analyzer_count(counts)
    if index < fridges:
        return "Vaccine room" if index % 2 == 0 else "Dispensary"
    if index < fridges + analyzers:
        return "Laboratory, bench 1"
    rest = index - fridges - analyzers
    place = vocabulary.EQUIPMENT[rest % len(vocabulary.EQUIPMENT)][1]
    return f"{place} {rest % 6 + 1}" if place == "Exam room" else place


def _field_value(
    organization: OrganizationPack,
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> JsonValue | object:
    """The value as people type it (spec R6, R7); pinned records stay exact."""
    value = _clean_field_value(organization, module, field, index, seed, anchor, counts)
    if index < PINNED or value is OMIT or field.value_kind not in _DIRTY_KINDS:
        return value
    kind = field.value_kind
    previous = index - 1 >= PINNED
    if kind == "title" and module.key in _NEAR_DUPLICATE_MODULES and index >= 2 * PINNED:
        rng = random.Random(f"{seed}:{module.key}:{index}:near-duplicate")
        if rng.random() < 0.03:
            other = _clean_field_value(organization, module, field, index - 7, seed, anchor, counts)
            if isinstance(other, str):
                return dirty_text(rng, other)
    note = (_clean_field_value(organization, module, field, index - 1, seed, anchor, counts)
            if kind == "notes" and previous else None)  # fmt: skip
    return dirty_value(
        random.Random(f"{seed}:{module.key}:{index}:{field.key}:dirt"),
        kind,
        value,
        required=field.required,
        country_code="1",
        quick_entry=random.Random(f"{seed}:{module.key}:{index}:quick").random() < DIRT.quick_entry,
        previous_note=note if isinstance(note, str) else None,
    )


_DIRTY_KINDS = frozenset({"title", "notes", "phone", "email", "url"})
# Named things where a second, slightly different entry for the same company appears.
_NEAR_DUPLICATE_MODULES = frozenset({"suppliers"})
