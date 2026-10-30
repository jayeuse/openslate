"""Clinic records agree with the records they link to: patients, claims, tubes and lots."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from uuid import NAMESPACE_URL, uuid5

import pytest

from operations.sample.blueprint import SampleDataset
from operations.sample.history import status_label
from operations.sample.packs.clinic import PACK
from operations.sample.population.board_entries import validate_board_scenarios
from operations.sample.scenario import build_dataset

ANCHOR = date(2026, 9, 30)


def _dataset(profile: str = "standard") -> SampleDataset:
    return build_dataset(profile, 42, ANCHOR, organization=PACK)


def _value(dataset: SampleDataset, records: dict, logical_id: str, field: str) -> object:
    record = records[logical_id]
    return record.data.get(dataset.field_ids[record.module_key][field])


def _number(dataset: SampleDataset, records: dict, logical_id: str, field: str) -> float:
    value = _value(dataset, records, logical_id, field)
    assert isinstance(value, int | float), (logical_id, field)
    return float(value)


def _edges(dataset: SampleDataset, key: str) -> list[tuple[str, str]]:
    relationship = dataset.relationship_ids[key]
    return [(e.source_record_id, e.target_record_id) for e in dataset.edges
            if e.relationship_id == relationship]  # fmt: skip


@pytest.mark.parametrize("profile", ["small", "standard", "large"])
def test_claim_balances_are_the_charge_less_the_payer_remittances(profile: str) -> None:
    dataset = _dataset(profile)
    records = {record.logical_id: record for record in dataset.records}
    paid: defaultdict[str, float] = defaultdict(float)
    for claim, payment in _edges(dataset, "claim_payments"):
        paid[claim] += _number(dataset, records, payment, "amount")
    failures = []
    for record in dataset.records:
        if record.module_key != "claims":
            continue
        charge = _number(dataset, records, record.logical_id, "charge_total")
        balance = _number(dataset, records, record.logical_id, "balance")
        label = status_label(dataset, "claims", record.data)
        if abs(charge - paid.get(record.logical_id, 0.0) - balance) > 0.011:
            failures.append((record.logical_id, "balance"))
        if (record.logical_id in paid) != (label in {"Paid", "Partially paid"}):
            failures.append((record.logical_id, label))
    assert failures == []
    assert [_value(dataset, records, "claims:000001", key) for key in ("charge_total", "balance")
            ] == [420, 120]  # fmt: skip
    assert _value(dataset, records, "payments:000001", "amount") == 300


def test_named_claim_records_pass_the_board_amount_check() -> None:
    dataset = _dataset("small")
    records = {
        record.logical_id: {"id": str(uuid5(NAMESPACE_URL, record.logical_id)),
                            "module_key": record.module_key,
                            "data": record.data}
        for record in dataset.records
    }  # fmt: skip
    design = dataset.document["design"]
    assert isinstance(design, dict)
    fields = {
        key: [field for module in design["modules"] if module["id"] == dataset.module_ids[key]
              for field in module["fields"]]
        for key in ("claims", "payments")
    }  # fmt: skip
    result = validate_board_scenarios(
        records, fields, organization=PACK, only=("claims:000001", "payments:000001")
    )
    assert (result["claim_total"], result["payment_amount"]) == (420, 300)


def test_linked_visit_records_are_about_the_same_patient() -> None:
    dataset = _dataset()
    patient_of = {
        appointment: patient for patient, appointment in _edges(dataset, "patient_appointments")
    }
    encounter_patient = dict(_edges(dataset, "encounter_patient"))
    failures = [
        encounter
        for encounter, appointment in _edges(dataset, "encounter_appointment")
        if encounter_patient[encounter] != patient_of[appointment]
    ]
    coverage_patient = {cov: patient for patient, cov in _edges(dataset, "patient_coverages")}
    claim_encounter = dict(_edges(dataset, "claim_encounter"))
    failures += [
        claim
        for claim, coverage in _edges(dataset, "claim_coverage")
        if coverage_patient[coverage] != encounter_patient[claim_encounter[claim]]
    ]
    assert failures == []
    assert len(claim_encounter) == dataset.module_counts["claims"]


def test_statuses_follow_the_records_linked_to_them() -> None:
    dataset = _dataset()
    records = {record.logical_id: record for record in dataset.records}

    def label(logical_id: str) -> str:
        return status_label(dataset, logical_id.split(":")[0], records[logical_id].data)

    seen = {appointment for _encounter, appointment in _edges(dataset, "encounter_appointment")}
    resulted = {specimen for specimen, _result in _edges(dataset, "specimen_results")}
    failures = [item for item in seen if label(item) in {"Booked", "No-show", "Waitlist"}]
    failures += [item for item in resulted if label(item) != "Available"]
    # A fill comes from a lot of the item that was prescribed.
    lot_of = {dispense: lot for lot, dispense in _edges(dataset, "lot_dispenses")}
    item_of = {lot: item for item, lot in _edges(dataset, "item_stock_lots")}
    for dispense, prescription in _edges(dataset, "dispense_prescription"):
        medication = str(_value(dataset, records, prescription, "medication"))
        generic = _value(dataset, records, item_of[lot_of[dispense]], "generic_name")
        strength = _value(dataset, records, item_of[lot_of[dispense]], "strength")
        if not medication.startswith(f"{generic} {strength}"):
            failures.append(dispense)
        lot_no = _value(dataset, records, lot_of[dispense], "lot_no")
        if _value(dataset, records, dispense, "lot_reference") != lot_no:
            failures.append(dispense)
    assert failures == []
