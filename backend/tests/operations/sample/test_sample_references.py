from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Callable
from datetime import date

import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from operations.sample.packs import get_pack
from operations.sample.packs.school.links import student_index
from operations.sample.scenario import SampleDataset, build_dataset

_HARBOR_CROSS_DEPARTMENT = {
    "site_customer",
    "invoice_customer",
    "invoice_sales_order",
    "request_equipment",
    "line_product",
    "movement_receipt",
    "order_warehouse",
    "work_order_products",
}


def _field(dataset: SampleDataset, module_key: str, name: str) -> dict[str, object]:
    module = next(
        module
        for module in dataset.document["design"]["modules"]
        if module["id"] == dataset.module_ids[module_key]
    )
    return next(field for field in module["fields"] if field["name"] == name)


def _value(dataset: SampleDataset, record: object, field_name: str) -> object:
    field = _field(dataset, record.module_key, field_name)
    return record.data[field["id"]]


def _index(logical_id: str) -> int:
    return int(logical_id.rsplit(":", 1)[1]) - 1


def _targets(dataset: SampleDataset, key: str) -> dict[str, list[str]]:
    """Each source record's targets for one relationship, in edge order."""
    targets: dict[str, list[str]] = defaultdict(list)
    for edge in dataset.edges:
        if edge.relationship_id == dataset.relationship_ids[key]:
            targets[edge.source_record_id].append(edge.target_record_id)
    return targets


def _cross_department_keys(dataset: SampleDataset) -> set[str]:
    department = {module.key: module.department for module in dataset.organization.catalog.modules}
    return {
        spec.key
        for spec in dataset.organization.catalog.relationships
        if department[spec.source] != department[spec.target]
    }


def test_relationship_definitions_and_edges_cross_departments_only_for_named_links() -> None:
    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 29))
    document = SandboxDocument.model_validate(dataset.document)
    record_by_id = {record.logical_id: record for record in dataset.records}
    specs = {spec.key: spec for spec in dataset.organization.catalog.relationships}

    assert len(document.design.relationships) == 26
    assert _cross_department_keys(dataset) == _HARBOR_CROSS_DEPARTMENT
    # The referencing record is the source and is created after the record it names.
    assert {key for key, spec in specs.items() if spec.child == "source"} == (
        _HARBOR_CROSS_DEPARTMENT
    )
    key_by_id = {value: key for key, value in dataset.relationship_ids.items()}
    cross_edges = 0
    for edge in dataset.edges:
        spec = specs[key_by_id[edge.relationship_id]]
        source, target = record_by_id[edge.source_record_id], record_by_id[edge.target_record_id]
        assert (source.module_key, target.module_key) == (spec.source, spec.target)
        cross_edges += source.actor_key != target.actor_key
    assert cross_edges == 635
    cardinality_by_key = {
        key: next(
            item.cardinality for item in document.design.relationships if item.id == relationship_id
        )
        for key, relationship_id in dataset.relationship_ids.items()
    }
    assert cardinality_by_key["work_order_inspections"] == "one-to-one"
    assert cardinality_by_key["invoice_sales_order"] == "one-to-one"
    assert cardinality_by_key["equipment_work_orders"] == "many-to-many"
    assert cardinality_by_key["invoice_customer"] == "many-to-many"
    assert set(cardinality_by_key.values()) == {"one-to-one", "one-to-many", "many-to-many"}
    equipment_by_work_order = Counter(
        edge.target_record_id
        for edge in dataset.edges
        if edge.relationship_id == dataset.relationship_ids["equipment_work_orders"]
    )
    assert set(equipment_by_work_order.values()) == {2}
    assert len(dataset.edges) == 1_780


@pytest.mark.parametrize("seed", [42, 7])
def test_cross_department_business_links_name_the_records_the_codes_named(seed: int) -> None:
    dataset = build_dataset("small", seed=seed, anchor_date=date(2026, 9, 29))
    records = {record.logical_id: record for record in dataset.records}
    counts = dataset.module_counts
    link_cases: tuple[tuple[str, str, str, Callable[[int], tuple[int, ...]]], ...] = (
        ("site_customer", "customer_sites", "customers", lambda index: (index,)),
        (
            "request_equipment",
            "service_requests",
            "equipment",
            lambda index: (index % counts["equipment"],),
        ),
        ("line_product", "purchase_lines", "products", lambda index: (index % counts["products"],)),
        ("movement_receipt", "stock_movements", "goods_receipts", lambda index: (index // 5,)),
        (
            "order_warehouse",
            "purchase_orders",
            "warehouses",
            lambda index: (index % counts["warehouses"],),
        ),
        ("invoice_customer", "invoices", "customers", lambda index: (index % counts["customers"],)),
        ("invoice_sales_order", "invoices", "sales_orders", lambda index: (index,)),
        (
            "work_order_products",
            "work_orders",
            "products",
            lambda index: ((index * 3) % counts["products"], (index * 3 + 13) % counts["products"]),
        ),
    )

    for key, source_module, target_module, target_indices in link_cases:
        targets = _targets(dataset, key)
        sources = [record for record in dataset.records if record.module_key == source_module]
        assert set(targets) == {record.logical_id for record in sources}
        for record in sources:
            expected = [
                f"{target_module}:{index + 1:06d}"
                for index in target_indices(_index(record.logical_id))
            ]
            assert targets[record.logical_id] == expected
            assert all(target in records for target in expected)

    # An invoice bills the same customer that placed its sales order.
    customer_by_order = {
        edge.target_record_id: edge.source_record_id
        for edge in dataset.edges
        if edge.relationship_id == dataset.relationship_ids["customer_orders"]
    }
    invoice_customers = _targets(dataset, "invoice_customer")
    for invoice, (order,) in _targets(dataset, "invoice_sales_order").items():
        assert invoice_customers[invoice] == [customer_by_order[order]]

    # The links replace the typed reference codes; no module keeps them as text.
    names = {
        field["name"]
        for module in dataset.document["design"]["modules"]
        for field in module["fields"]
    }
    assert not names & {
        "Customer reference",
        "Sales order reference",
        "Equipment reference",
        "Product reference",
        "Goods receipt reference",
        "Warehouse reference",
        "Products used",
    }


def test_school_links_across_departments_and_keeps_in_department_codes_as_text() -> None:
    dataset = build_dataset(
        "small", seed=42, anchor_date=date(2026, 9, 30), organization=get_pack("school")
    )
    records = {record.logical_id: record for record in dataset.records}
    counts = dataset.module_counts
    cross = _cross_department_keys(dataset)
    assert len(cross) == 15
    assert {
        spec.key for spec in dataset.organization.catalog.relationships if spec.child == "source"
    } == cross
    assert len(dataset.organization.catalog.relationships) == 30
    assert (
        sum(
            records[edge.source_record_id].actor_key != records[edge.target_record_id].actor_key
            for edge in dataset.edges
        )
        == 415
    )

    student_links = {
        "behaviour_student": "behaviour_incidents",
        "guidance_student": "guidance_cases",
        "parent_contact_student": "parent_contacts",
        "clinic_visit_student": "clinic_visits",
        "health_alert_student": "health_alerts",
        "fee_assessment_student": "fee_assessments",
        "fee_adjustment_student": "fee_adjustments",
        "collection_student": "collection_cases",
    }
    for key, module_key in student_links.items():
        targets = _targets(dataset, key)
        sources = [record for record in dataset.records if record.module_key == module_key]
        assert set(targets) == {record.logical_id for record in sources}
        for record in sources:
            student = student_index(module_key, _index(record.logical_id), counts)
            assert targets[record.logical_id] == [f"students:{student + 1:06d}"]

    single_links = {
        "student_application": ("students:000001", "applications:000005"),
        "attendance_clinic_visit": ("attendance_exceptions:000006", "clinic_visits:000001"),
        "guidance_attendance": ("guidance_cases:000001", "attendance_exceptions:000005"),
        "parent_contact_attendance": ("parent_contacts:000001", "attendance_exceptions:000001"),
        "parent_contact_academic_alert": ("parent_contacts:000002", "academic_alerts:000001"),
    }
    for key, (source, target) in single_links.items():
        assert _targets(dataset, key) == {source: [target]}
    rooms = counts["rooms"]
    for key, module_key, room in (
        ("section_room", "class_sections", lambda index: index % rooms),
        ("activity_room", "activities", lambda index: (index * 3) % rooms),
    ):
        targets = _targets(dataset, key)
        for record in (item for item in dataset.records if item.module_key == module_key):
            assert targets[record.logical_id] == [
                f"rooms:{room(_index(record.logical_id)) + 1:06d}"
            ]

    # Codes that repeat a link inside the same department stay as typed text.
    kept = dataset.organization.links.reference_fields
    assert set(kept) == {
        ("attendance_exceptions", "student_reference"),
        ("academic_alerts", "student_reference"),
        ("grade_change_requests", "student_reference"),
        ("payments", "fee_assessment_reference"),
    }
    department = {module.key: module.department for module in dataset.organization.catalog.modules}
    for module_key, field_key in kept:
        for target_module, _index_value in dataset.organization.links.reference_parents(
            dataset.organization, module_key, field_key, 0, counts
        ):
            assert department[target_module] == department[module_key]
        assert field_key in dataset.field_ids[module_key]
