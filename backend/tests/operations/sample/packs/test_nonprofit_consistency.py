"""Fairhaven records agree with the records they link to: pledges, advances and orders."""

from __future__ import annotations

from collections import defaultdict
from datetime import date

import pytest

from operations.sample.blueprint import SampleDataset, SampleRecord
from operations.sample.history import status_label
from operations.sample.packs.nonprofit import PACK
from operations.sample.scenario import build_dataset

ANCHOR = date(2026, 9, 30)


def _dataset(profile: str = "standard") -> SampleDataset:
    return build_dataset(profile, 42, ANCHOR, organization=PACK)


def _value(dataset: SampleDataset, record: SampleRecord, field: str) -> object:
    return record.data.get(dataset.field_ids[record.module_key][field])


def _number(dataset: SampleDataset, record: SampleRecord, field: str) -> float:
    value = _value(dataset, record, field)
    assert isinstance(value, int | float), (record.logical_id, field)
    return float(value)


def _edges(dataset: SampleDataset, key: str) -> list[tuple[str, str]]:
    relationship = dataset.relationship_ids[key]
    return [(e.source_record_id, e.target_record_id) for e in dataset.edges
            if e.relationship_id == relationship]  # fmt: skip


@pytest.mark.parametrize("profile", ["small", "standard", "large"])
def test_balances_are_the_amount_less_the_linked_payments(profile: str) -> None:
    dataset = _dataset(profile)
    records = {record.logical_id: record for record in dataset.records}
    paid: defaultdict[str, float] = defaultdict(float)
    for pledge, donation in _edges(dataset, "pledge_donations"):
        paid[pledge] += _number(dataset, records[donation], "amount")
    liquidated: defaultdict[str, float] = defaultdict(float)
    for advance, line in _edges(dataset, "advance_expenses"):
        liquidated[advance] += _number(dataset, records[line], "amount")
    failures = []
    for record in dataset.records:
        rid = record.logical_id
        if record.module_key == "pledges":
            total = _number(dataset, record, "total_amount")
            if abs(total - paid[rid] - _number(dataset, record, "balance_due")) > 0.011:
                failures.append(rid)
            if status_label(dataset, "pledges", record.data) == "Completed" and paid[rid] < total:
                failures.append(rid)
        if record.module_key == "cash_advances":
            if abs(_number(dataset, record, "amount_liquidated") - liquidated[rid]) > 0.011:
                failures.append(rid)
            released = _number(dataset, record, "amount_released")
            if abs(released - liquidated[rid] - _number(dataset, record, "balance")) > 0.011:
                failures.append(rid)
    assert failures == []
    pledge, advance = records["pledges:000001"], records["cash_advances:000001"]
    assert [_value(dataset, pledge, key) for key in ("total_amount", "balance_due")] == [
        120_000, 90_000]  # fmt: skip
    assert _value(dataset, records["donations:000001"], "amount") == 30_000
    assert [_value(dataset, advance, key) for key in ("amount_released", "amount_liquidated",
                                                      "balance")] == [25_000, 18_750, 6_250]


def test_vouchers_repeat_the_advance_or_order_they_pay() -> None:
    dataset = _dataset()
    records = {record.logical_id: record for record in dataset.records}
    failures = []
    for advance, voucher in _edges(dataset, "advance_release"):
        if _value(dataset, records[advance], "amount_released") != _value(
            dataset, records[voucher], "amount"
        ):
            failures.append(voucher)
    for voucher, order in _edges(dataset, "disbursement_order"):
        if _value(dataset, records[voucher], "amount") != _value(dataset, records[order],
                                                                  "amount"):  # fmt: skip
            failures.append(voucher)
        if status_label(dataset, "purchase_orders", records[order].data) not in {"Paid", "Closed"}:
            failures.append(order)
    released = {advance for advance, _voucher in _edges(dataset, "advance_release")}
    unreleased = [record.logical_id for record in dataset.records
                  if record.module_key == "cash_advances" and record.logical_id not in released
                  and status_label(dataset, "cash_advances", record.data)
                  not in {"Requested", "Approved", "Rejected"}]  # fmt: skip
    assert failures == [] and unreleased == []


def test_statuses_follow_the_records_linked_to_them() -> None:
    dataset = _dataset()
    records = {record.logical_id: record for record in dataset.records}

    def label(logical_id: str) -> str:
        return status_label(dataset, logical_id.split(":")[0], records[logical_id].data)

    failures = [order for request, order in _edges(dataset, "request_orders")
                if label(request) not in {"Completed", "PO issued"}]  # fmt: skip
    failures += [line for _fund, grant in _edges(dataset, "fund_grant")
                 for line in [grant] if label(grant) not in {"Active", "Closing", "Closed",
                                                             "Awarded – contracting"}]
    failures += [line for grant, line in _edges(dataset, "grant_budget_lines")
                 if label(grant) not in {"Active", "Closing", "Closed", "Awarded – contracting"}]
    failures += [item for beneficiary, item in _edges(dataset, "beneficiary_assistance")
                 if label(beneficiary) not in {"Active", "Exited", "Verified"}]  # fmt: skip
    # Each participant is in a project that works in the participant's own community.
    site_projects = defaultdict(set)
    for project, site in _edges(dataset, "project_sites"):
        site_projects[site].add(project)
    site_of = {person: site for site, person in _edges(dataset, "site_beneficiaries")}
    failures += [person for project, person in _edges(dataset, "project_beneficiaries")
                 if project not in site_projects[site_of[person]]]  # fmt: skip
    assert failures == []
