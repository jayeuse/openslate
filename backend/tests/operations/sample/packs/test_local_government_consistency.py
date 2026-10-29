"""City records agree with the records they link to: orders and receipts, requests and crews,
vouchers and releases, and the procurement chain."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from functools import cache
from uuid import NAMESPACE_URL, uuid5

import pytest

from operations.sample.blueprint import SampleDataset, SampleRecord
from operations.sample.history import status_label
from operations.sample.packs.local_government import PACK
from operations.sample.population.board_entries import validate_board_scenarios
from operations.sample.scenario import build_dataset

ANCHOR = date(2026, 9, 30)


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
def test_order_balances_are_the_amount_due_less_the_receipts_that_pay_it(profile: str) -> None:
    dataset = _dataset(profile)
    records = _records(dataset)
    paid: defaultdict[str, float] = defaultdict(float)
    for order, receipt in _edges(dataset, "order_receipts"):
        paid[order] += _number(dataset, records[receipt], "amount")
    failures = []
    for record in dataset.records:
        if record.module_key != "payment_orders":
            continue
        label = _label(dataset, record)
        surcharge = _value(dataset, record, "surcharge")
        due = _number(dataset, record, "amount_due") + (
            0.0 if surcharge is None else _number(dataset, record, "surcharge")
        )
        balance = _number(dataset, record, "balance")
        expected = (
            0.0 if label in {"Reassessed", "Cancelled"} else due - paid.get(record.logical_id, 0)
        )
        if abs(balance - expected) > 0.011:
            failures.append((record.logical_id, "balance"))
        if (record.logical_id in paid) != (label in {"Paid", "Partially paid"}):
            failures.append((record.logical_id, label))
    assert failures == []
    order, receipt = records["payment_orders:000001"], records["official_receipts:000001"]
    assert [_value(dataset, order, key) for key in ("amount_due", "balance")] == [32_400, 24_300]
    assert _value(dataset, receipt, "amount") == 8_100


def test_named_installment_records_pass_the_board_amount_check() -> None:
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
        for key in ("payment_orders", "official_receipts")
    }  # fmt: skip
    result = validate_board_scenarios(
        records, fields, organization=PACK,
        only=("payment_orders:000001", "official_receipts:000001"),
    )  # fmt: skip
    assert (result["amount_due"], result["receipt_amount"]) == (32_400, 8_100)


def test_statuses_follow_the_records_linked_to_them() -> None:
    dataset = _dataset()
    records = _records(dataset)
    failures: list[object] = []
    # A permit is released only after a receipt paid its order of payment.
    paid_orders = {order for order, _receipt in _edges(dataset, "order_receipts")}
    orders_of: defaultdict[str, set[str]] = defaultdict(set)
    for order, app in _edges(dataset, "order_application"):
        orders_of[app].add(order)
    for record in dataset.records:
        if record.module_key == "permit_applications" and _label(dataset, record) == "Released":
            if not orders_of[record.logical_id] & paid_orders:
                failures.append(record.logical_id)
    # A request a crew fixed has a completed work order; a fixed crew job closes its requests.
    work = {request: order for request, order in _edges(dataset, "request_work_orders")}
    for request, order in work.items():
        if _label(dataset, records[order]) in {"Completed", "Verified"}:
            if _label(dataset, records[request]) != "Fixed":
                failures.append(request)
    # A voucher is paid exactly when its release was released or cleared.
    released = {voucher: release for release, voucher in _edges(dataset, "release_voucher")}
    for record in dataset.records:
        if record.module_key == "disbursement_vouchers" and _label(dataset, record) == "Paid":
            release = released.get(record.logical_id)
            if release is None or _label(dataset, records[release]) not in {
                "Released", "Cleared", "Stale"}:  # fmt: skip
                failures.append(record.logical_id)
    assert failures == []


def test_purchase_orders_go_to_the_winning_bidder_within_the_approved_budget() -> None:
    dataset = _dataset()
    records = _records(dataset)
    supplier_of_bid = {bid: supplier for supplier, bid in _edges(dataset, "supplier_bids")}
    bids_of: defaultdict[str, list[str]] = defaultdict(list)
    for project, bid in _edges(dataset, "project_bids"):
        bids_of[project].append(bid)
    supplier_of_order = {
        po: supplier for supplier, po in _edges(dataset, "supplier_purchase_orders")
    }
    failures: list[object] = []
    for project, po in _edges(dataset, "project_purchase_orders"):
        ranked = sorted(
            bids_of[project], key=lambda bid: _number(dataset, records[bid], "bid_amount")
        )
        if supplier_of_order[po] != supplier_of_bid[ranked[0]]:
            failures.append((po, "supplier"))
    for project, bid in _edges(dataset, "project_bids"):
        budget = _number(dataset, records[project], "abc_total")
        if _number(dataset, records[bid], "bid_amount") > budget:
            failures.append((bid, "over the ABC"))
    # Each supplier bids once per project.
    pairs = [(project, supplier_of_bid[bid]) for project, bid in _edges(dataset, "project_bids")]
    assert len(pairs) == len(set(pairs))
    assert failures == []


def test_purchase_request_mode_follows_the_procurement_thresholds() -> None:
    dataset = _dataset()
    failures = []
    for record in dataset.records:
        if record.module_key != "purchase_requests":
            continue
        mode_id = _value(dataset, record, "recommended_mode")
        if mode_id is None:
            continue
        abc = _number(dataset, record, "abc_amount")
        labels = {"Competitive bidding": abc >= 2_000_000, "Direct acquisition": abc <= 200_000}
        mode = next(label for label in ("Competitive bidding", "Direct acquisition",
                                        "Small value procurement")
                    if mode_id == _option(dataset, label))  # fmt: skip
        expected = next((label for label, applies in labels.items() if applies),
                        "Small value procurement")  # fmt: skip
        if mode != expected:
            failures.append(record.logical_id)
    assert failures == []


def _option(dataset: SampleDataset, label: str) -> str:
    from operations.sample.blueprint import _option_id

    return _option_id(dataset.seed, "purchase_requests", "recommended_mode", label, PACK)
