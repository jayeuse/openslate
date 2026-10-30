"""Clinic record and date chains: every child is dated on or after the record it names."""

from __future__ import annotations

from datetime import date

from operations.sample.blueprint import SampleDataset, SampleRecord
from operations.sample.packs.types import JsonValue

# Relationship, parent date field, child date field, and whether the dates are equal.
# The parent is the relationship end created first.
_LINKED_DATES = (
    ("encounter_appointment", "visit_date", "visit_date", True),
    ("encounter_orders", "visit_date", "ordered_on", True),
    ("encounter_prescriptions", "visit_date", "prescribed_on", True),
    ("claim_encounter", "visit_date", "service_date", True),
    ("specimen_orders", "ordered_on", "collected_on", False),
    ("specimen_results", "collected_on", "resulted_on", False),
    ("result_order", "ordered_on", "resulted_on", False),
    ("dispense_prescription", "prescribed_on", "dispensed_on", False),
    ("claim_responses", "submitted_on", "received_on", False),
    ("claim_payments", "submitted_on", "paid_on", False),
    ("request_orders", "requested_on", "order_date", False),
)
# Things that already happened are not dated after the anchor date.
_PAST = (
    ("orders", "ordered_on"),
    ("specimens", "collected_on"),
    ("lab_results", "resulted_on"),
    ("lab_qc_runs", "run_date"),
    ("temperature_logs", "check_date"),
    ("dispenses", "dispensed_on"),
    ("claims", "service_date"),
    ("claim_responses", "received_on"),
    ("payments", "paid_on"),
    ("purchase_orders", "order_date"),
    ("incident_reports", "occurred_on"),
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
                continue  # A draft claim is not submitted yet.
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
    excursion = _day(dataset, records["temperature_logs:000001"], "check_date")
    incident = _day(dataset, records["incident_reports:000001"], "occurred_on")
    assert excursion == incident
