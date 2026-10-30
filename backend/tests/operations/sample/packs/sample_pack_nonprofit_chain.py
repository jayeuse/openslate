"""Fairhaven record and date chains: every child is dated on or after the record it follows."""

from __future__ import annotations

from datetime import date

from operations.sample.blueprint import SampleDataset, SampleRecord
from operations.sample.packs.types import JsonValue

# Relationship, parent date field, child date field, and whether the dates are equal.
# The parent is the relationship end created first.
_LINKED_DATES = (
    ("pledge_donations", "pledge_date", "gift_date", False),
    ("advance_expenses", "released_on", "expense_date", False),
    ("advance_release", "released_on", "voucher_date", True),
    ("request_orders", "requested_on", "issued_on", False),
    ("disbursement_order", "issued_on", "voucher_date", False),
    ("beneficiary_assistance", "registered_on", "delivered_on", False),
    ("activity_assistance", "actual_on", "delivered_on", False),
)
# Things that already happened are not dated after the anchor date.
_PAST = (
    ("donations", "gift_date"),
    ("donations", "acknowledged_on"),
    ("beneficiaries", "registered_on"),
    ("assistance", "delivered_on"),
    ("activities", "actual_on"),
    ("feedback_cases", "received_on"),
    ("cash_advances", "requested_on"),
    ("cash_advances", "released_on"),
    ("expense_lines", "expense_date"),
    ("disbursements", "voucher_date"),
    ("purchase_requests", "requested_on"),
    ("purchase_orders", "issued_on"),
    ("indicator_results", "submitted_on"),
)
# Dates that come in order on one record.
_SAME_RECORD = (
    ("cash_advances", "requested_on", "released_on"),
    ("cash_advances", "released_on", "liquidation_due"),
    ("donations", "gift_date", "acknowledged_on"),
    ("pledges", "pledge_date", "first_due"),
    ("indicator_results", "period_end", "submitted_on"),
    ("activities", "planned_on", "actual_on"),
    ("purchase_requests", "requested_on", "needed_by"),
    ("purchase_orders", "issued_on", "delivery_due"),
    ("campaigns", "starts_on", "ends_on"),
)


def _day(dataset: SampleDataset, record: SampleRecord, field_key: str) -> date | None:
    value: JsonValue = record.data.get(dataset.field_ids[record.module_key][field_key])
    return date.fromisoformat(value[:10]) if isinstance(value, str) else None


def validate_dates(dataset: SampleDataset) -> None:
    records = {record.logical_id: record for record in dataset.records}
    relationships = {spec.key: spec for spec in dataset.organization.catalog.relationships}
    for key, parent_field, child_field, same_day in _LINKED_DATES:
        spec = relationships[key]
        edges = [
            edge for edge in dataset.edges if edge.relationship_id == dataset.relationship_ids[key]
        ]
        assert edges, key
        for edge in edges:
            source, target = records[edge.source_record_id], records[edge.target_record_id]
            parent, child = (target, source) if spec.child == "source" else (source, target)
            earlier, later = _day(dataset, parent, parent_field), _day(dataset, child, child_field)
            assert earlier is not None and later is not None, (key, child.logical_id)
            assert (earlier == later) if same_day else (earlier <= later), (
                key,
                parent.logical_id,
                child.logical_id,
            )
    for module_key, field_key in _PAST:
        for record in dataset.records:
            if record.module_key == module_key:
                day = _day(dataset, record, field_key)
                assert day is None or day <= dataset.anchor_date, (record.logical_id, field_key)
    for module_key, first, second in _SAME_RECORD:
        for record in dataset.records:
            if record.module_key == module_key:
                earlier, later = _day(dataset, record, first), _day(dataset, record, second)
                if earlier is not None and later is not None:
                    assert earlier <= later, (record.logical_id, first, second)
    disputed = _day(dataset, records["assistance:000005"], "delivered_on")
    feedback = _day(dataset, records["feedback_cases:000001"], "received_on")
    assert disputed is not None and feedback is not None and disputed <= feedback
