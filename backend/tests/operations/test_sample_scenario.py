from __future__ import annotations

from collections import Counter
from datetime import date

import pytest

from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.validation import validate_document
from operations.sample_scenario import build_dataset, build_document, module_counts

STANDARD_COUNTS = {
    "customers": 300,
    "contacts": 600,
    "quotes": 800,
    "sales_orders": 2_000,
    "customer_sites": 300,
    "service_contracts": 200,
    "service_requests": 1_200,
    "request_updates": 1_400,
    "equipment": 600,
    "work_orders": 2_000,
    "inspections": 1_000,
    "maintenance_plans": 200,
    "products": 500,
    "warehouses": 10,
    "stock_movements": 3_500,
    "stock_counts": 490,
    "suppliers": 100,
    "purchase_orders": 700,
    "purchase_lines": 1_400,
    "goods_receipts": 700,
    "invoices": 800,
    "payments": 600,
    "expenses": 500,
    "credit_notes": 100,
}


def _module(dataset, key: str) -> dict[str, object]:
    return next(
        module
        for module in dataset.document["design"]["modules"]
        if module["id"] == dataset.module_ids[key]
    )


def _field(dataset, module_key: str, name: str) -> dict[str, object]:
    return next(item for item in _module(dataset, module_key)["fields"] if item["name"] == name)


def _value(dataset, record, name: str) -> object:
    field = _field(dataset, record.module_key, name)
    return record.data[field["id"]]


def _select_label(dataset, record, name: str) -> str:
    field = _field(dataset, record.module_key, name)
    value = record.data.get(field["id"], field["config"].get("defaultValue"))
    return next(option["label"] for option in field["config"]["options"] if option["id"] == value)


def _records_by_id(dataset) -> dict[str, object]:
    return {record.logical_id: record for record in dataset.records}


def _relationship_id(dataset, key: str) -> str:
    return dataset.relationship_ids[key]


def _edges_for(dataset, relationship_key: str):
    relationship_id = _relationship_id(dataset, relationship_key)
    return [edge for edge in dataset.edges if edge.relationship_id == relationship_id]


def test_profiles_have_the_admitted_exact_counts() -> None:
    expected_small = {
        "customers": 15,
        "contacts": 30,
        "quotes": 40,
        "sales_orders": 100,
        "customer_sites": 15,
        "service_contracts": 10,
        "service_requests": 60,
        "request_updates": 70,
        "equipment": 30,
        "work_orders": 100,
        "inspections": 50,
        "maintenance_plans": 10,
        "products": 25,
        "warehouses": 1,
        "stock_movements": 175,
        "stock_counts": 25,
        "suppliers": 5,
        "purchase_orders": 35,
        "purchase_lines": 70,
        "goods_receipts": 35,
        "invoices": 40,
        "payments": 30,
        "expenses": 25,
        "credit_notes": 5,
    }

    assert module_counts("standard") == STANDARD_COUNTS
    assert sum(module_counts("standard").values()) == 20_000
    assert module_counts("small") == expected_small
    assert sum(module_counts("small").values()) == 1_001
    assert module_counts("large") == {key: value * 5 for key, value in STANDARD_COUNTS.items()}
    assert sum(module_counts("large").values()) == 100_000
    with pytest.raises(ValueError, match="profile"):
        module_counts("enormous")


def test_document_uses_only_the_current_valid_v4_authoring_contract() -> None:
    payload = build_document(seed=42, anchor_date=date(2026, 9, 29))
    document = SandboxDocument.model_validate(payload)

    assert validate_document(document) == []
    assert payload["schemaVersion"] == 4
    assert len(document.design.departments) == 6
    assert len(document.design.modules) == 24
    assert set(document.scenarios) == set()
    assert set(document.design.layout) == {
        item.id for item in document.design.departments + document.design.modules
    }

    field_types = {field.type for module in document.design.modules for field in module.fields}
    assert field_types == {
        "Text",
        "Long text",
        "Number",
        "Integer",
        "Date",
        "Date/Time",
        "Checkbox",
        "Select",
        "Email",
        "URL",
        "User",
    }
    for module in document.design.modules:
        assert module.title_field_id is not None
        title = next(field for field in module.fields if field.id == module.title_field_id)
        assert title.type == "Text" and title.required
        for field in module.fields:
            if field.type == "Select":
                option_ids = [option.id for option in field.config.options]
                assert len(option_ids) == len(set(option_ids))
                assert all(len(option_id) == 36 for option_id in option_ids)
            if field.type == "Number":
                assert field.config.kind == "number"

    cardinalities = {item.cardinality for item in document.design.relationships}
    assert cardinalities == {"one-to-one", "one-to-many", "many-to-many"}
    assert all(not relationship.field_mappings for relationship in document.design.relationships)
    assert len(document.triggers) == 8
    assert {trigger.trigger.kind for trigger in document.triggers} == {
        "record-created",
        "field-changed",
        "threshold-crossed",
        "schedule",
    }
    assert {trigger.condition_group.operator for trigger in document.triggers} == {"all", "any"}
    assert all(
        action.kind == "set-field" for trigger in document.triggers for action in trigger.actions
    )
    schedules = [trigger for trigger in document.triggers if trigger.trigger.kind == "schedule"]
    assert {trigger.trigger.frequency for trigger in schedules} == {"daily", "weekly"}
    assert all(not trigger.enabled for trigger in schedules)


def test_dataset_is_seeded_complete_and_repeatable_for_an_explicit_anchor() -> None:
    anchor = date(2026, 9, 29)
    first = build_dataset("small", seed=42, anchor_date=anchor)
    repeated = build_dataset("small", seed=42, anchor_date=anchor)

    assert first == repeated
    assert len(first.department_ids) == 6
    assert len(first.module_ids) == 24
    assert set(first.field_ids) == set(first.module_ids)
    assert len(first.records) == 1_001
    assert set(Counter(record.module_key for record in first.records).items()) == set(
        module_counts("small").items()
    )

    actor_keys = {"sales", "service", "field", "inventory", "purchasing", "finance"}
    non_empty_values: set[str] = set()
    values_seen: list[object] = []
    date_values: list[date] = []
    for record in first.records:
        module = _module(first, record.module_key)
        fields = {field["id"]: field for field in module["fields"]}
        assert record.actor_key in actor_keys
        assert set(record.data).issubset(fields)
        assert all(
            not field["required"]
            or (
                field_id in record.data
                and record.data[field_id] is not None
                and record.data[field_id] != ""
            )
            for field_id, field in fields.items()
        )
        for field_id, value in record.data.items():
            field = fields[field_id]
            values_seen.append(value)
            if value not in (None, ""):
                non_empty_values.add(str(value))
            if field["type"] == "User":
                assert value == f"@user:{record.assignee_key}"
            if field["type"] in {"Date", "Date/Time"} and isinstance(value, str):
                date_values.append(date.fromisoformat(value[:10]))

    assert date_values
    assert min(date_values) >= anchor.fromordinal(anchor.toordinal() - 365)
    assert max(date_values) <= anchor.fromordinal(anchor.toordinal() + 90)
    assert "" in values_seen
    assert 0 in values_seen
    assert False in values_seen
    assert any(
        field.get("config", {}).get("defaultValue") is not None and field["id"] not in record.data
        for record in first.records
        for field in _module(first, record.module_key)["fields"]
    )
    assert len(non_empty_values) > 100
    assert build_document(seed=43, anchor_date=anchor) != first.document


def test_named_financial_and_purchase_flows_reconcile_through_links_and_references() -> None:
    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 29))
    records = _records_by_id(dataset)

    invoice = records["invoices:000001"]
    payment = records["payments:000001"]
    assert _value(dataset, invoice, "Total") == 12_000
    assert _value(dataset, payment, "Amount") == 4_500
    linked_payments = {
        edge.target_record_id
        for edge in _edges_for(dataset, "invoice_payments")
        if edge.source_record_id == invoice.logical_id
    }
    assert linked_payments == {payment.logical_id}
    assert (
        _value(dataset, invoice, "Total")
        - sum(_value(dataset, records[payment_id], "Amount") for payment_id in linked_payments)
        == 7_500
    )

    lines_by_order: dict[str, list[str]] = {}
    for edge in _edges_for(dataset, "purchase_order_lines"):
        lines_by_order.setdefault(edge.source_record_id, []).append(edge.target_record_id)
    receipts_by_order: dict[str, list[str]] = {}
    for edge in _edges_for(dataset, "purchase_order_receipts"):
        receipts_by_order.setdefault(edge.source_record_id, []).append(edge.target_record_id)
    movements_by_receipt: dict[str, list[str]] = {}
    for movement in (item for item in dataset.records if item.module_key == "stock_movements"):
        receipt_reference = str(_value(dataset, movement, "Goods receipt reference"))
        movements_by_receipt.setdefault(receipt_reference, []).append(movement.logical_id)

    for order_id, line_ids in lines_by_order.items():
        order = records[order_id]
        assert _value(dataset, order, "Total") == sum(
            _value(dataset, records[line_id], "Line total") for line_id in line_ids
        )
        order_receipts = receipts_by_order.get(order_id, [])
        ordered_quantity = sum(
            _value(dataset, records[line_id], "Quantity") for line_id in line_ids
        )
        if _select_label(dataset, order, "Status") == "Cancelled":
            assert order_receipts == []
            continue
        assert order_receipts
        assert (
            sum(
                _value(dataset, records[receipt_id], "Units accepted")
                for receipt_id in order_receipts
            )
            <= ordered_quantity
        )
        for receipt_id in order_receipts:
            receipt = records[receipt_id]
            assert _value(dataset, receipt, "Units accepted") <= ordered_quantity
            assert _value(dataset, receipt, "Units accepted") == sum(
                _value(dataset, records[movement_id], "Quantity")
                for movement_id in movements_by_receipt[str(_value(dataset, receipt, "Reference"))]
            )

    payments_by_invoice: dict[str, list[str]] = {}
    for edge in _edges_for(dataset, "invoice_payments"):
        payments_by_invoice.setdefault(edge.source_record_id, []).append(edge.target_record_id)
    for invoice in (record for record in dataset.records if record.module_key == "invoices"):
        paid = sum(
            _value(dataset, records[payment_id], "Amount")
            for payment_id in payments_by_invoice.get(invoice.logical_id, [])
        )
        total = _value(dataset, invoice, "Total")
        status = _select_label(dataset, invoice, "Status")
        assert status != "Cancelled" or paid == 0
        assert status != "Paid" or paid == total
        assert status != "Partially paid" or 0 < paid < total
        assert not payments_by_invoice.get(invoice.logical_id) or status != "Cancelled"


def test_generated_edges_respect_each_declared_cardinality() -> None:
    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 29))
    document = SandboxDocument.model_validate(dataset.document)
    relationships = {item.id: item for item in document.design.relationships}
    edges_by_relationship: dict[str, list[object]] = {}
    for edge in dataset.edges:
        edges_by_relationship.setdefault(edge.relationship_id, []).append(edge)

    for relationship_id, relationship in relationships.items():
        edges = edges_by_relationship[relationship_id]
        sources = [edge.source_record_id for edge in edges]
        targets = [edge.target_record_id for edge in edges]
        if relationship.cardinality == "one-to-one":
            assert len(sources) == len(set(sources))
            assert len(targets) == len(set(targets))
        elif relationship.cardinality == "one-to-many":
            assert len(targets) == len(set(targets))
        else:
            assert len(set(sources)) < len(sources)
            assert len(set(targets)) < len(targets)


def test_temporary_test_vectors_cover_each_trigger_without_storing_scenarios() -> None:
    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 29))
    payload = SandboxDocument.model_validate(dataset.document)
    triggers_by_id = {trigger.id: trigger for trigger in payload.triggers}
    assert payload.scenarios == []
    assert len(dataset.test_vectors) == len(payload.triggers) == 8
    assert len(dataset.trigger_ids) == 8
    assert {vector.key for vector in dataset.test_vectors} == set(dataset.trigger_ids)

    event_kinds = Counter(vector.event["kind"] for vector in dataset.test_vectors)
    assert event_kinds == {
        "record-created": 2,
        "field-changed": 2,
        "threshold-crossed": 2,
        "schedule": 2,
    }
    assert {
        vector.event.get("frequency")
        for vector in dataset.test_vectors
        if vector.event["kind"] == "schedule"
    } == {
        "daily",
        "weekly",
    }

    for vector in dataset.test_vectors:
        module_id = dataset.module_ids[vector.module_key]
        module = next(item for item in payload.design.modules if item.id == module_id)
        fields = {field.id: field for field in module.fields}
        assert set(vector.values).issubset(fields)
        assert all(
            field_id in vector.values for field_id, field in fields.items() if field.required
        )
        assert all(fields[field_id].type != "User" for field_id in vector.values)
        assert len(vector.trigger_ids) == 1
        trigger = triggers_by_id[vector.trigger_ids[0]]
        assert dataset.trigger_ids[vector.key] == trigger.id
        if vector.event["kind"] in {"field-changed", "threshold-crossed"}:
            assert "previousValue" in vector.event
        if trigger.trigger.kind == "threshold-crossed":
            threshold = trigger.trigger.value.value
            previous = vector.event["previousValue"]
            current = vector.values[trigger.trigger.field_id]
            assert isinstance(threshold, (int, float))
            assert isinstance(previous, (int, float))
            assert isinstance(current, (int, float))
            if trigger.trigger.operator == ">":
                assert previous <= threshold < current
            else:
                assert previous < threshold <= current
            for condition in trigger.condition_group.conditions:
                actual = vector.values[condition.field.field_id]
                expected = condition.value.value
                assert isinstance(actual, (int, float))
                assert isinstance(expected, (int, float))
                assert actual > expected if condition.operator == ">" else actual >= expected
        if vector.event["kind"] == "schedule":
            assert not trigger.enabled


@pytest.mark.parametrize("profile", ["small", "standard", "large"])
def test_purchase_and_sales_document_statuses_match_their_linked_activity(profile: str) -> None:
    dataset = build_dataset(profile, seed=42, anchor_date=date(2026, 9, 29))
    purchase_cases = {
        1: ("Delayed", ("Received", "Partially received"), 30),
        3: ("Partially received", ("Partially received", "Received"), 30),
        17: ("Partially received", ("Partially received", "Received"), 27),
    }
    order_ids = {f"purchase_orders:{index + 1:06d}" for index in purchase_cases}
    receipt_ids = {
        edge.target_record_id
        for edge in _edges_for(dataset, "purchase_order_receipts")
        if edge.source_record_id in order_ids
    }
    wanted = receipt_ids | order_ids | {
        f"purchase_lines:{index * 2 + line + 1:06d}"
        for index in purchase_cases
        for line in (0, 1)
    } | {
        "sales_orders:000003", "sales_orders:000008", "invoices:000003",
        "invoices:000008", "payments:000007", "sales_orders:001001", "invoices:001001",
    }
    records = {
        record.logical_id: record for record in dataset.records if record.logical_id in wanted
    }

    for index, (expected_order, expected_lines, accepted_total) in purchase_cases.items():
        order_id = f"purchase_orders:{index + 1:06d}"
        line_ids = {
            f"purchase_lines:{index * 2 + line + 1:06d}" for line in (0, 1)
        }
        assert {
            edge.target_record_id
            for edge in _edges_for(dataset, "purchase_order_lines")
            if edge.source_record_id == order_id
        } == line_ids
        assert _select_label(dataset, records[order_id], "Status") == expected_order
        assert tuple(
            _select_label(dataset, records[f"purchase_lines:{index * 2 + line + 1:06d}"], "Status")
            for line in (0, 1)
        ) == expected_lines
        assert sum(
            _value(dataset, records[edge.target_record_id], "Units accepted")
            for edge in _edges_for(dataset, "purchase_order_receipts")
            if edge.source_record_id == order_id
        ) == accepted_total

    assert _select_label(dataset, records["sales_orders:000003"], "Status") == "Cancelled"
    assert _select_label(dataset, records["invoices:000003"], "Status") == "Cancelled"
    assert _select_label(dataset, records["sales_orders:000008"], "Status") != "Cancelled"
    assert _select_label(dataset, records["invoices:000008"], "Status") == "Overdue"
    assert _select_label(dataset, records["payments:000007"], "Status") == "Posted"
    assert _value(dataset, records["invoices:000008"], "Sales order reference") == _value(
        dataset, records["sales_orders:000008"], "Reference"
    )
    assert any(
        edge.source_record_id == "invoices:000008"
        and edge.target_record_id == "payments:000007"
        for edge in _edges_for(dataset, "invoice_payments")
    )
    orders_by_reference = {
        str(_value(dataset, order, "Reference")): order
        for order in dataset.records
        if order.module_key == "sales_orders"
    }
    for invoice in (item for item in dataset.records if item.module_key == "invoices"):
        order = orders_by_reference[str(_value(dataset, invoice, "Sales order reference"))]
        order_cancelled = _select_label(dataset, order, "Status") == "Cancelled"
        invoice_cancelled = _select_label(dataset, invoice, "Status") == "Cancelled"
        assert order_cancelled == invoice_cancelled
    if profile == "standard":
        assert _select_label(dataset, records["sales_orders:001001"], "Status") == "Cancelled"
    if profile == "large":
        assert _select_label(dataset, records["sales_orders:001001"], "Status") != "Cancelled"
        assert _select_label(dataset, records["invoices:001001"], "Status") != "Cancelled"
