"""Distributor record and date chains: every child is dated on or after the record it names."""

from __future__ import annotations

from datetime import date

from operations.sample.blueprint import SampleDataset, SampleRecord
from operations.sample.packs.types import JsonValue

# Relationship, parent date field, child date field, and whether the dates are equal.
# The parent is the relationship end created first.
_LINKED_DATES = (
    ("order_visit", "visit_date", "order_date", True),
    ("tour_visits", "tour_date", "visit_date", True),
    ("invoice_tour", "tour_date", "invoice_date", True),
    ("receipt_lots", "received_on", "received_on", True),
    ("trip_orders", "order_date", "trip_date", False),
    ("invoice_order", "order_date", "invoice_date", False),
    ("invoice_receipts", "invoice_date", "receipt_date", False),
    ("invoice_followups", "due_date", "followup_date", False),
    ("receipt_po", "po_date", "received_on", False),
    ("lot_adjustments", "received_on", "adjusted_on", False),
    ("return_invoice", "invoice_date", "reported_on", False),
    ("ap_invoice_po", "po_date", "invoice_date", False),
    ("claim_receipt", "received_on", "filed_on", False),
    ("claim_promotions", "end_date", "filed_on", False),
    ("claim_returns", "reported_on", "filed_on", False),
)
# Things that already happened are not dated after the anchor date.
_PAST = (
    ("sales_orders", "order_date"),
    ("delivery_trips", "trip_date"),
    ("sales_invoices", "invoice_date"),
    ("collection_receipts", "receipt_date"),
    ("collection_followups", "followup_date"),
    ("goods_receipts", "received_on"),
    ("stock_lots", "received_on"),
    ("stock_adjustments", "adjusted_on"),
    ("returns", "reported_on"),
    ("credit_reviews", "requested_on"),
    ("principal_invoices", "invoice_date"),
    ("principal_claims", "filed_on"),
)
# Dates that come in order on one record.
_SAME_RECORD = (
    ("sales_orders", "order_date", "requested_delivery"),
    ("sales_invoices", "invoice_date", "due_date"),
    ("trade_promotions", "start_date", "end_date"),
    ("trade_promotions", "end_date", "claim_deadline"),
    ("purchase_orders", "po_date", "expected_delivery"),
    ("returns", "reported_on", "pickup_date"),
    ("principal_invoices", "invoice_date", "due_date"),
    ("collection_followups", "followup_date", "promise_date"),
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
    # The named follow-ups come after the records whose flag they answer.
    flagged = _day(dataset, records["goods_receipts:000005"], "received_on")
    claim = _day(dataset, records["principal_claims:000001"], "filed_on")
    assert flagged is not None and claim is not None and flagged <= claim
