"""Silangan records agree with the records they link to: orders, invoices, tours and stock."""

from __future__ import annotations

from collections import defaultdict
from datetime import date

import pytest

from operations.sample.blueprint import SampleDataset, SampleRecord
from operations.sample.history import status_label
from operations.sample.packs.fmcg_distributor import PACK
from operations.sample.scenario import build_dataset

ANCHOR = date(2026, 9, 30)


def _dataset(profile: str = "standard") -> SampleDataset:
    return build_dataset(profile, 42, ANCHOR, organization=PACK)


def _value(dataset: SampleDataset, record: SampleRecord, field: str) -> object:
    return record.data.get(dataset.field_ids[record.module_key][field])


def _number(dataset: SampleDataset, record: SampleRecord, field: str) -> float:
    value = _value(dataset, record, field)
    return 0.0 if value is None else float(value)  # type: ignore[arg-type]


def _edges(dataset: SampleDataset, key: str) -> list[tuple[str, str]]:
    relationship = dataset.relationship_ids[key]
    return [(e.source_record_id, e.target_record_id) for e in dataset.edges
            if e.relationship_id == relationship]  # fmt: skip


def _label(dataset: SampleDataset, records: dict[str, SampleRecord], logical_id: str) -> str:
    return status_label(dataset, logical_id.split(":")[0], records[logical_id].data)


@pytest.mark.parametrize("profile", ["small", "standard", "large"])
def test_order_and_invoice_totals_add_up_from_their_lines_and_receipts(profile: str) -> None:
    dataset = _dataset(profile)
    records = {record.logical_id: record for record in dataset.records}
    lines: defaultdict[str, float] = defaultdict(float)
    for order, line in _edges(dataset, "order_lines"):
        lines[order] += _number(dataset, records[line], "line_total")
    paid: defaultdict[str, float] = defaultdict(float)
    statements: defaultdict[str, list[str]] = defaultdict(list)
    for invoice, receipt in _edges(dataset, "invoice_receipts"):
        statements[receipt].append(invoice)
    for receipt, members in statements.items():
        if _label(dataset, records, receipt) in {"Bounced", "Voided"}:
            continue
        for invoice in members:
            share = _number(dataset, records[invoice], "amount") if len(members) > 1 else (
                _number(dataset, records[receipt], "amount"))  # fmt: skip
            paid[invoice] += share
    failures = []
    for record in dataset.records:
        rid = record.logical_id
        if record.module_key == "sales_orders" and abs(
            _number(dataset, record, "order_total") - lines[rid]) > 0.011:  # fmt: skip
            failures.append(rid)
        if record.module_key == "sales_invoices" and _label(dataset, records, rid) != "Voided":
            balance = _number(dataset, record, "amount") - paid[rid]
            if abs(max(0.0, balance) - _number(dataset, record, "balance")) > 0.011:
                failures.append(rid)
    for receipt, members in statements.items():
        if len(members) > 1 and abs(_number(dataset, records[receipt], "amount") - sum(
                _number(dataset, records[item], "amount") for item in members)) > 0.011:
            failures.append(receipt)  # fmt: skip
    assert failures == []
    invoice, receipt = records["sales_invoices:000001"], records["collection_receipts:000001"]
    assert [_value(dataset, invoice, key) for key in ("amount", "balance")] == [24_600, 14_600]
    assert _value(dataset, receipt, "amount") == 10_000


def test_invoices_bill_what_was_delivered_to_the_order_or_tour_outlet() -> None:
    dataset = _dataset()
    records = {record.logical_id: record for record in dataset.records}
    outlet_of = dict(_edges(dataset, "invoice_outlet"))
    order_outlet = {order: outlet for outlet, order in _edges(dataset, "outlet_orders")}
    delivered: defaultdict[str, float] = defaultdict(float)
    for order, line in _edges(dataset, "order_lines"):
        if _label(dataset, records, line) == "Delivered":
            delivered[order] += _number(dataset, records[line], "line_total")
    failures = []
    for invoice, order in _edges(dataset, "invoice_order"):
        if outlet_of[invoice] != order_outlet[order]:
            failures.append(invoice)
        if abs(_number(dataset, records[invoice], "amount") - delivered[order]) > 0.011:
            failures.append(invoice)
        if _label(dataset, records, order) not in {"Delivered", "Partially delivered"}:
            failures.append(order)
    van_sales: defaultdict[str, float] = defaultdict(float)
    for invoice, tour in _edges(dataset, "invoice_tour"):
        if _label(dataset, records, invoice) != "Voided":
            van_sales[tour] += _number(dataset, records[invoice], "amount")
    for record in dataset.records:
        if record.module_key == "route_tours" and record.logical_id in van_sales:
            if abs(_number(dataset, record, "sales_value") - van_sales[record.logical_id]) > 0.011:
                failures.append(record.logical_id)
    assert failures == []


def test_stock_follows_the_purchase_orders_and_receipts_it_came_on() -> None:
    dataset = _dataset()
    records = {record.logical_id: record for record in dataset.records}
    totals: defaultdict[str, float] = defaultdict(float)
    for po, line in _edges(dataset, "po_lines"):
        totals[po] += _number(dataset, records[line], "line_total")
    receipt_po = dict(_edges(dataset, "receipt_po"))
    po_lines: defaultdict[str, set[str]] = defaultdict(set)
    for po, line in _edges(dataset, "po_lines"):
        po_lines[po].add(line)
    line_product = {line: product for product, line in _edges(dataset, "product_po_lines")}
    lot_product = dict(_edges(dataset, "lot_product"))
    failures = [po for po, total in totals.items()
                if abs(_number(dataset, records[po], "po_total") - total) > 0.011]  # fmt: skip
    for receipt, lot in _edges(dataset, "receipt_lots"):
        products = {line_product[line] for line in po_lines[receipt_po[receipt]]}
        if lot_product[lot] not in products:
            failures.append(lot)
        if _label(dataset, records, receipt) not in {"Posted", "Posted with discrepancy"}:
            failures.append(receipt)
    for receipt, po in _edges(dataset, "receipt_po"):
        if _label(dataset, records, po) not in {"Closed", "Received", "Partially received"}:
            failures.append(receipt)
    assert failures == []
