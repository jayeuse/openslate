"""Clinic departments, Sandbox modules, relationships, and size profiles."""

from __future__ import annotations

from typing import Literal

from operations.sample.packs.clinic.catalog_access import MODULES as _ACCESS
from operations.sample.packs.clinic.catalog_clinical import CLINICAL, LABORATORY
from operations.sample.packs.clinic.catalog_supply import OPERATIONS, PHARMACY, QUALITY, REVENUE
from operations.sample.packs.types import RelationshipSpec, SampleProfile

Cardinality = Literal["one-to-one", "one-to-many", "many-to-many"]

_DEPARTMENTS = (
    ("patient_access", "Patient Access"),
    ("clinical", "Clinical Services"),
    ("laboratory", "Laboratory"),
    ("pharmacy", "Pharmacy"),
    ("revenue_cycle", "Revenue Cycle"),
    ("operations", "Operations and Supply"),
    ("quality", "Quality and Compliance"),
)

_MODULES = (*_ACCESS, *CLINICAL, *LABORATORY, *PHARMACY, *REVENUE, *OPERATIONS, *QUALITY)


def _link(
    key: str, name: str, source: str, target: str, cardinality: Cardinality = "one-to-many"
) -> RelationshipSpec:
    """A link inside one department: the later (target) record links to its parent."""
    return RelationshipSpec(key, name, source, target, cardinality)


def _names(
    key: str, name: str, source: str, target: str, cardinality: Cardinality
) -> RelationshipSpec:
    """A record that names a record kept in another department links itself (rule 11)."""
    return RelationshipSpec(key, name, source, target, cardinality, child="source")


_RELATIONSHIPS = (
    _link("patient_coverages", "Coverages", "patients", "coverages"),
    _link("payer_coverages", "Coverages", "payers", "coverages"),
    _link("patient_appointments", "Appointments", "patients", "appointments"),
    _link("encounter_orders", "Orders", "encounters", "orders"),
    _link("encounter_prescriptions", "Prescriptions", "encounters", "prescriptions"),
    _link("specimen_results", "Results", "specimens", "lab_results"),
    _link("item_stock_lots", "Stock lots", "pharmacy_items", "stock_lots"),
    _link("lot_dispenses", "Dispenses", "stock_lots", "dispenses"),
    _link("claim_responses", "Responses", "claims", "claim_responses"),
    _link("claim_payments", "Payments", "claims", "payments"),
    _link("supplier_purchase_orders", "Purchase orders", "suppliers", "purchase_orders"),
    _link("request_orders", "Purchase orders", "purchase_requests", "purchase_orders",
          "many-to-many"),  # fmt: skip
    _link("equipment_work_orders", "Work orders", "equipment", "maintenance_work_orders"),
    # Links to records in another department.
    _names("encounter_appointment", "Appointment", "encounters", "appointments", "one-to-one"),
    _names("encounter_patient", "Patient", "encounters", "patients", "many-to-many"),
    _names("specimen_orders", "Orders", "specimens", "orders", "many-to-many"),
    _names("result_order", "Order", "lab_results", "orders", "many-to-many"),
    _names("qc_run_analyzer", "Analyzer", "lab_qc_runs", "equipment", "many-to-many"),
    _names("dispense_prescription", "Prescription", "dispenses", "prescriptions",
           "many-to-many"),  # fmt: skip
    _names("temperature_log_unit", "Refrigerator", "temperature_logs", "equipment",
           "many-to-many"),  # fmt: skip
    _names("claim_encounter", "Encounter", "claims", "encounters", "many-to-many"),
    _names("claim_coverage", "Coverage", "claims", "coverages", "many-to-many"),
    _names("payment_patient", "Patient", "payments", "patients", "many-to-many"),
    _names("incident_equipment", "Equipment", "incident_reports", "equipment", "many-to-many"),
    _names("incident_temperature_log", "Temperature log", "incident_reports",
           "temperature_logs", "one-to-one"),  # fmt: skip
)

_STANDARD_COUNTS = {module.key: module.standard_count for module in _MODULES}
PROFILE_COUNTS: dict[SampleProfile, dict[str, int]] = {
    "small": {key: max(1, (count + 4) // 5) for key, count in _STANDARD_COUNTS.items()},
    "standard": dict(_STANDARD_COUNTS),
    "large": {key: count * 4 for key, count in _STANDARD_COUNTS.items()},
}
SPECIAL_STATUSES: dict[str, dict[int, str]] = {}
