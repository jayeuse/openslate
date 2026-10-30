"""Sauce plant record and date chains: every child is dated on or after what it names."""

from __future__ import annotations

from datetime import date

from operations.sample.blueprint import SampleDataset, SampleRecord
from operations.sample.packs.types import JsonValue

# Relationship, parent date field, child date field, and whether the dates are equal.
# The parent is the relationship end created first.
_LINKED_DATES = (
    ("order_lines", "order_date", "promised_date", False),
    ("shipment_sales_order", "order_date", "ship_date", False),
    ("shipment_finished_lots", "production_date", "ship_date", False),
    ("invoice_shipment", "ship_date", "invoice_date", True),
    ("invoice_payments", "invoice_date", "payment_date", False),
    ("lot_purchase_order", "order_date", "received_date", False),
    ("supplier_invoice_order", "order_date", "invoice_date", False),
    ("order_sales_order", "order_date", "planned_start", False),
    ("batch_production_order", "planned_start", "batch_date", False),
    ("batch_material_lots", "received_date", "batch_date", False),
    ("finished_lot_order", "planned_start", "production_date", False),
    ("report_downtime", "report_date", "event_date", True),
    ("ncr_material_lots", "received_date", "opened_on", False),
    ("ncr_batches", "batch_date", "opened_on", False),
    ("ncr_finished_lots", "production_date", "opened_on", False),
    ("capa_ncrs", "opened_on", "opened_on", False),
    ("work_order_downtime", "event_date", "requested_on", True),
)
# Things that already happened are not dated after the anchor date.
_PAST = (
    ("sales_orders", "order_date"),
    ("purchase_orders", "order_date"),
    ("material_lots", "received_date"),
    ("batch_records", "batch_date"),
    ("shift_reports", "report_date"),
    ("downtime_events", "event_date"),
    ("finished_goods_lots", "production_date"),
    ("finished_goods_lots", "release_date"),
    ("food_safety_logs", "log_date"),
    ("ncrs", "opened_on"),
    ("capas", "opened_on"),
    ("maintenance_work_orders", "requested_on"),
    ("supplier_invoices", "invoice_date"),
    ("customer_invoices", "invoice_date"),
    ("customer_payments", "payment_date"),
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
    # The planned follow-ups come after the record whose create rule flagged them.
    lot = _day(dataset, records["material_lots:000001"], "received_date")
    ncr = _day(dataset, records["ncrs:000001"], "opened_on")
    assert lot is not None and ncr is not None and lot <= ncr
