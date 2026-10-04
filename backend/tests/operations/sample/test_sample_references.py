from __future__ import annotations

from collections import Counter
from datetime import date

import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from operations.sample.scenario import SampleDataset, build_dataset


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


def test_relationship_definitions_and_edges_are_same_department() -> None:
    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 29))
    document = SandboxDocument.model_validate(dataset.document)
    department_by_module = {module.id: module.department_id for module in document.design.modules}
    record_by_id = {record.logical_id: record for record in dataset.records}

    assert len(document.design.relationships) == 18
    assert all(
        department_by_module[item.source_module_id] == department_by_module[item.target_module_id]
        for item in document.design.relationships
    )
    assert all(
        record_by_id[edge.source_record_id].actor_key
        == record_by_id[edge.target_record_id].actor_key
        for edge in dataset.edges
    )
    cardinality_by_key = {
        key: next(
            item.cardinality for item in document.design.relationships if item.id == relationship_id
        )
        for key, relationship_id in dataset.relationship_ids.items()
    }
    assert cardinality_by_key["work_order_inspections"] == "one-to-one"
    assert cardinality_by_key["equipment_work_orders"] == "many-to-many"
    assert set(cardinality_by_key.values()) == {"one-to-one", "one-to-many", "many-to-many"}
    equipment_by_work_order = Counter(
        edge.target_record_id
        for edge in dataset.edges
        if edge.relationship_id == dataset.relationship_ids["equipment_work_orders"]
    )
    assert set(equipment_by_work_order.values()) == {2}
    assert len(dataset.edges) == 1_145


@pytest.mark.parametrize("seed", [42, 7])
def test_cross_department_business_links_use_enterable_reference_codes(seed: int) -> None:
    dataset = build_dataset("small", seed=seed, anchor_date=date(2026, 9, 29))
    records = {record.logical_id: record for record in dataset.records}
    counts = dataset.module_counts
    reference_cases = (
        ("customer_sites", "Customer reference", "customers", lambda index: index),
        (
            "service_requests",
            "Equipment reference",
            "equipment",
            lambda index: index % counts["equipment"],
        ),
        (
            "purchase_lines",
            "Product reference",
            "products",
            lambda index: index % counts["products"],
        ),
        (
            "stock_movements",
            "Goods receipt reference",
            "goods_receipts",
            lambda index: index // 5,
        ),
        (
            "purchase_orders",
            "Warehouse reference",
            "warehouses",
            lambda index: index % counts["warehouses"],
        ),
        ("invoices", "Customer reference", "customers", lambda index: index % counts["customers"]),
        ("invoices", "Sales order reference", "sales_orders", lambda index: index),
    )

    for module_key, field_name, target_module, target_index in reference_cases:
        assert _field(dataset, module_key, field_name)["type"] == "Text"
        for record in (item for item in dataset.records if item.module_key == module_key):
            index = int(record.logical_id.rsplit(":", 1)[1]) - 1
            target = records[f"{target_module}:{target_index(index) + 1:06d}"]
            assert _value(dataset, record, field_name) == _value(dataset, target, "Reference")

    customer_by_order = {
        edge.target_record_id: edge.source_record_id
        for edge in dataset.edges
        if edge.relationship_id == dataset.relationship_ids["customer_orders"]
    }
    orders_by_reference = {
        str(_value(dataset, record, "Reference")): record
        for record in dataset.records
        if record.module_key == "sales_orders"
    }
    for invoice in (item for item in dataset.records if item.module_key == "invoices"):
        order = orders_by_reference[str(_value(dataset, invoice, "Sales order reference"))]
        customer = records[customer_by_order[order.logical_id]]
        assert _value(dataset, invoice, "Customer reference") == _value(
            dataset, customer, "Reference"
        )

    assert _field(dataset, "work_orders", "Products used")["type"] == "Long text"
    for record in (item for item in dataset.records if item.module_key == "work_orders"):
        index = int(record.logical_id.rsplit(":", 1)[1]) - 1
        product_indices = (
            (index * 3) % counts["products"],
            (index * 3 + 13) % counts["products"],
        )
        expected = "; ".join(
            _value(dataset, records[f"products:{product_index + 1:06d}"], "Reference")
            for product_index in product_indices
        )
        assert _value(dataset, record, "Products used") == expected
