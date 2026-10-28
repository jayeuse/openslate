"""Plant records agree with the records they link to: invoices and payments, orders and
lines, batches and their pH, shipments and the finished lots they carry."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from functools import cache
from uuid import NAMESPACE_URL, uuid5

import pytest

from operations.sample.blueprint import SampleDataset, SampleRecord
from operations.sample.history import status_label
from operations.sample.packs.manufacturer import PACK
from operations.sample.population.board_entries import validate_board_scenarios
from operations.sample.scenario import build_dataset

ANCHOR = date(2026, 9, 30)
_HELD_BATCHES = {"QA hold", "Reprocess", "Destroyed"}


@cache
def _dataset(profile: str = "standard") -> SampleDataset:
    return build_dataset(profile, 42, ANCHOR, organization=PACK)


def _records(dataset: SampleDataset) -> dict[str, SampleRecord]:
    return {record.logical_id: record for record in dataset.records}


def _value(dataset: SampleDataset, record: SampleRecord, field: str) -> object:
    return record.data.get(dataset.field_ids[record.module_key][field])


def _number(dataset: SampleDataset, record: SampleRecord, field: str) -> float:
    value = _value(dataset, record, field)
    assert isinstance(value, int | float), (record.logical_id, field)
    return float(value)


def _label(dataset: SampleDataset, record: SampleRecord) -> str:
    return status_label(dataset, record.module_key, record.data)


def _edges(dataset: SampleDataset, key: str) -> list[tuple[str, str]]:
    relationship = dataset.relationship_ids[key]
    return [(e.source_record_id, e.target_record_id) for e in dataset.edges
            if e.relationship_id == relationship]  # fmt: skip


@pytest.mark.parametrize("profile", ["small", "standard", "large"])
def test_invoice_balances_are_the_amount_less_the_payments_applied_to_it(profile: str) -> None:
    dataset = _dataset(profile)
    records = _records(dataset)
    paid: defaultdict[str, float] = defaultdict(float)
    for invoice, payment in _edges(dataset, "invoice_payments"):
        paid[invoice] += _number(dataset, records[payment], "amount")
    failures = []
    for record in dataset.records:
        if record.module_key != "customer_invoices":
            continue
        label = _label(dataset, record)
        amount = _number(dataset, record, "amount")
        balance = _number(dataset, record, "balance")
        expected = 0.0 if label == "Credited" else amount - paid.get(record.logical_id, 0.0)
        if abs(balance - expected) > 0.011:
            failures.append((record.logical_id, "balance"))
        if (record.logical_id in paid) != (label in {"Paid", "Partially paid"}):
            failures.append((record.logical_id, label))
        if label == "Paid" and abs(balance) > 0.011:
            failures.append((record.logical_id, "paid with a balance"))
    assert failures == []
    invoice, payment = records["customer_invoices:000001"], records["customer_payments:000001"]
    assert [_value(dataset, invoice, key) for key in ("amount", "balance")] == [12_480, 3_120]
    assert _value(dataset, payment, "amount") == 9_360


def test_named_part_payment_records_pass_the_board_amount_check() -> None:
    dataset = _dataset("small")
    records = {
        record.logical_id: {"id": str(uuid5(NAMESPACE_URL, record.logical_id)),
                            "module_key": record.module_key, "data": record.data}
        for record in dataset.records
    }  # fmt: skip
    design = dataset.document["design"]
    assert isinstance(design, dict)
    fields = {
        key: [field for module in design["modules"] if module["id"] == dataset.module_ids[key]
              for field in module["fields"]]
        for key in ("customer_invoices", "customer_payments")
    }  # fmt: skip
    result = validate_board_scenarios(
        records, fields, organization=PACK,
        only=("customer_invoices:000001", "customer_payments:000001"),
    )  # fmt: skip
    assert (result["invoice_amount"], result["payment_amount"]) == (12_480, 9_360)


def test_order_values_are_the_sum_of_their_open_and_shipped_lines() -> None:
    dataset = _dataset()
    records = _records(dataset)
    totals: defaultdict[str, float] = defaultdict(float)
    for order, line in _edges(dataset, "order_lines"):
        if _label(dataset, records[line]) != "Cancelled":
            totals[order] += _number(dataset, records[line], "qty_cases") * _number(
                dataset, records[line], "unit_price"
            )
    failures = [
        record.logical_id for record in dataset.records
        if record.module_key == "sales_orders"
        and abs(_number(dataset, record, "order_value") - totals[record.logical_id]) > 0.011
    ]  # fmt: skip
    assert failures == []


def test_statuses_follow_the_records_linked_to_them() -> None:
    dataset = _dataset()
    records = _records(dataset)
    failures: list[object] = []
    # A sauce batch above the pH action limit is held; a released one is below it.
    for record in dataset.records:
        if record.module_key != "batch_records":
            continue
        ph = _number(dataset, record, "equilibrium_ph")
        if ph < 5 and (ph > 4.4) != (_label(dataset, record) in _HELD_BATCHES):
            failures.append(record.logical_id)
    # A shipped load carries lots that QA released and shipped out (positive release).
    for shipment, lot in _edges(dataset, "shipment_finished_lots"):
        if _label(dataset, records[shipment]) in {"Delivered", "Shipped", "Refused"}:
            if _label(dataset, records[lot]) != "Shipped out":
                failures.append((shipment, lot))
    # A refused load is credited, never paid.
    for invoice, shipment in _edges(dataset, "invoice_shipment"):
        refused = _label(dataset, records[shipment]) == "Refused"
        if refused != (_label(dataset, records[invoice]) == "Credited"):
            failures.append((invoice, shipment))
    # A shipment goes out only for an order that is being shipped.
    for shipment, order in _edges(dataset, "shipment_sales_order"):
        if _label(dataset, records[order]) not in {
            "Allocated", "Partially shipped", "Shipped", "Invoiced", "Closed"}:  # fmt: skip
            failures.append((shipment, order))
    assert failures == []


def test_batches_use_ingredient_lots_that_were_released_for_use() -> None:
    dataset = _dataset()
    records = _records(dataset)
    used = {lot for _batch, lot in _edges(dataset, "batch_material_lots")}
    assert used
    assert {_label(dataset, records[lot]) for lot in used} <= {"Consumed", "Released"}
