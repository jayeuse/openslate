"""Harbor's publishable record automations, authored as Set field rules."""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample_blueprint import _option_id
from operations.sample_catalog import _doc_id
from operations.sample_packs.interface import OrganizationPack
from operations.sample_packs.types import JsonValue


def _ref(
    seed: int,
    module_key: str,
    field_ids: Mapping[str, Mapping[str, str]],
    field_key: str,
    organization: OrganizationPack,
) -> dict[str, str]:
    return {
        "moduleId": _doc_id(seed, "module", module_key, organization),
        "fieldId": field_ids[module_key][field_key],
    }


def _trigger_condition(
    seed: int,
    module_key: str,
    field_ids: Mapping[str, Mapping[str, str]],
    field_key: str,
    operator: str,
    value: JsonValue,
    organization: OrganizationPack,
) -> dict[str, object]:
    return {
        "id": _doc_id(
            seed, "condition", f"{module_key}:{field_key}:{operator}:{value}", organization
        ),
        "field": _ref(seed, module_key, field_ids, field_key, organization),
        "operator": operator,
        "value": {"kind": "literal", "value": value},
    }


def _trigger_action(
    seed: int,
    module_key: str,
    field_ids: Mapping[str, Mapping[str, str]],
    field_key: str,
    value: JsonValue,
    organization: OrganizationPack,
) -> dict[str, object]:
    return {
        "id": _doc_id(seed, "action", f"{module_key}:{field_key}:{value}", organization),
        "kind": "set-field",
        "target": _ref(seed, module_key, field_ids, field_key, organization),
        "value": {"kind": "literal", "value": value},
    }


def build_triggers(
    organization: OrganizationPack,
    seed: int,
    module_ids: Mapping[str, str],
    field_ids: Mapping[str, Mapping[str, str]],
) -> list[dict[str, object]]:
    def status(module_key: str, label: str) -> str:
        return _option_id(seed, module_key, "status", label, organization)

    def event(kind: str, module_id: str, **values: object) -> dict[str, object]:
        return {"kind": kind, "moduleId": module_id, **values}

    def trigger(
        key: str,
        name: str,
        module_key: str,
        event: dict[str, object],
        conditions: list[dict[str, object]],
        operator: str,
        target: str,
        value: JsonValue,
        *,
        enabled: bool = True,
    ) -> dict[str, object]:
        return {
            "id": _doc_id(seed, "trigger", key, organization),
            "name": name,
            "enabled": enabled,
            "priority": len(key),
            "trigger": event,
            "conditionGroup": {"operator": operator, "conditions": conditions},
            "actions": [_trigger_action(seed, module_key, field_ids, target, value, organization)],
        }

    sales_id, service_id = module_ids["sales_orders"], module_ids["service_requests"]
    stock_id, plan_id = module_ids["stock_counts"], module_ids["maintenance_plans"]
    invoice_id, movement_id = module_ids["invoices"], module_ids["stock_movements"]
    work_id, quote_id = module_ids["work_orders"], module_ids["quotes"]
    order_conditions = [
        _trigger_condition(
            seed,
            "sales_orders",
            field_ids,
            "status",
            "=",
            status("sales_orders", "Draft"),
            organization,
        ),
        _trigger_condition(seed, "sales_orders", field_ids, "total", ">=", 5_000, organization),
    ]
    request_conditions = [
        _trigger_condition(
            seed,
            "service_requests",
            field_ids,
            "status",
            "=",
            status("service_requests", "Open"),
            organization,
        ),
        _trigger_condition(
            seed,
            "service_requests",
            field_ids,
            "priority",
            "=",
            _option_id(seed, "service_requests", "priority", "Urgent", organization),
            organization,
        ),
    ]
    quote_conditions = [
        _trigger_condition(seed, "quotes", field_ids, "total", ">=", 5_000, organization)
    ]
    work_conditions = [
        _trigger_condition(
            seed,
            "work_orders",
            field_ids,
            "status",
            "=",
            status("work_orders", "Scheduled"),
            organization,
        ),
        _trigger_condition(
            seed,
            "work_orders",
            field_ids,
            "status",
            "=",
            status("work_orders", "Overdue"),
            organization,
        ),
    ]
    invoice_conditions = [
        _trigger_condition(seed, "invoices", field_ids, "total", ">", 10_000, organization)
    ]
    movement_conditions = [
        _trigger_condition(seed, "stock_movements", field_ids, "quantity", ">=", 20, organization)
    ]
    stock_conditions = [
        _trigger_condition(
            seed,
            "stock_counts",
            field_ids,
            "status",
            "=",
            status("stock_counts", "Variance found"),
            organization,
        )
    ]
    plan_conditions = [
        _trigger_condition(
            seed,
            "maintenance_plans",
            field_ids,
            "status",
            "=",
            status("maintenance_plans", "Scheduled"),
            organization,
        )
    ]
    # fmt: off
    return [
        trigger("order-created-confirmation", "Confirm qualified sales orders", "sales_orders",
                event("record-created", sales_id), order_conditions, "all", "status",
                status("sales_orders", "Confirmed")),
        trigger("urgent-request-created", "Start urgent requests", "service_requests",
                event("record-created", service_id), request_conditions, "all", "status",
                status("service_requests", "In progress")),
        trigger("quote-value-changed", "Flag high value quotes", "quotes",
                event("field-changed", quote_id, fieldId=field_ids["quotes"]["total"]),
                quote_conditions, "all", "accepted", True),
        trigger("work-order-state-changed", "Mark work orders for follow-up", "work_orders",
                event("field-changed", work_id, fieldId=field_ids["work_orders"]["status"]),
                work_conditions, "any", "follow_up", True),
        trigger("large-invoice-threshold", "Review large invoices", "invoices",
                event("threshold-crossed", invoice_id, fieldId=field_ids["invoices"]["total"],
                      operator=">", value={"kind": "literal", "value": 10_000}),
                invoice_conditions, "all", "review_required", True),
        trigger("large-movement-threshold", "Count large stock receipts", "stock_movements",
                event("threshold-crossed", movement_id,
                      fieldId=field_ids["stock_movements"]["quantity"],
                      operator=">=", value={"kind": "literal", "value": 20}),
                movement_conditions, "all", "cycle_count", True),
        trigger("daily-stock-review", "Daily stock variance review", "stock_counts",
                event("schedule", stock_id, frequency="daily", time="09:00"),
                stock_conditions, "all", "recount", True, enabled=False),
        trigger("weekly-maintenance-review", "Weekly maintenance review", "maintenance_plans",
                event("schedule", plan_id, frequency="weekly", time="09:00", weekday=1),
                plan_conditions, "any", "enabled", True, enabled=False),
    ]
    # fmt: on
