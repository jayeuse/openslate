"""City government record and date chains: every child is dated on or after what it names."""

from __future__ import annotations

from datetime import date

from operations.sample.blueprint import SampleDataset, SampleRecord
from operations.sample.packs.types import JsonValue

# Relationship, parent date field, child date field, and whether the dates are equal.
# The parent is the relationship end created first.
_LINKED_DATES = (
    ("order_application", "filed_on", "assessed_on", False),
    ("order_building_permit", "filed_on", "assessed_on", False),
    ("order_receipts", "assessed_on", "issued_on", False),
    ("permit_inspections", "filed_on", "scheduled_on", False),
    ("inspection_notices", "inspected_on", "issued_on", False),
    ("request_work_orders", "requested_on", "scheduled_on", False),
    ("obligation_vouchers", "filed_on", "received_on", False),
    ("release_voucher", "received_on", "prepared_on", False),
    ("obligation_purchase_order", "po_date", "filed_on", False),
    ("project_requests", "requested_on", "posted_on", False),
    ("project_bids", "posted_on", "submitted_on", False),
    ("project_purchase_orders", "posted_on", "po_date", False),
    ("order_acceptance_reports", "po_date", "delivered_on", False),
    ("voucher_acceptance_reports", "accepted_on", "received_on", False),
    ("measure_communications", "filed_on", "dated_on", False),
)
# Things that already happened are not dated after the anchor date.
_PAST = (
    ("permit_applications", "filed_on"),
    ("permit_applications", "released_on"),
    ("enforcement_notices", "issued_on"),
    ("building_permits", "filed_on"),
    ("service_requests", "requested_on"),
    ("payment_orders", "assessed_on"),
    ("official_receipts", "issued_on"),
    ("deposit_reports", "report_date"),
    ("payment_releases", "prepared_on"),
    ("obligation_requests", "filed_on"),
    ("disbursement_vouchers", "received_on"),
    ("purchase_requests", "requested_on"),
    ("purchase_orders", "po_date"),
    ("acceptance_reports", "delivered_on"),
    ("communications", "dated_on"),
    ("legislative_measures", "filed_on"),
    ("civil_registry", "registered_on"),
    ("civil_registry", "event_date"),
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
            if earlier is None or later is None:
                continue  # A project still at its pre-procurement conference is not posted.
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
    for record in dataset.records:
        if record.module_key == "civil_registry":
            assert _day(dataset, record, "event_date") <= _day(dataset, record, "registered_on")
    inspection = _day(dataset, records["business_inspections:000001"], "inspected_on")
    notice = _day(dataset, records["enforcement_notices:000001"], "issued_on")
    assert inspection is not None and notice is not None and inspection <= notice
