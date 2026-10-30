"""Seven supported sauce plant Set-field rules, with the weekly parts review disabled.

The research's create-record automations become a flag on the same record plus a planned
human step (plan rule 5): a rejected receipt flags the NCR a QA technician opens; a critical
NCR flags the CAPA the QA manager opens; a breakdown of 30 minutes or more flags the
corrective work order the maintenance planner raises. The pH rule publishes as it is.
"""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample.blueprint import _option_id
from operations.sample.catalog import _doc_id
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.types import JsonValue

RECORD_CREATED_KEYS = ("rejected-lot-ncr", "critical-ncr-capa", "breakdown-work-order")
PATCH_KEYS = (
    "batch-ph-qa-hold",
    "low-oee-review",
    "paste-tote-reorder",
    "price-variance-exception",
)
SCHEDULE_KEYS = ("weekly-parts-review",)
TRIGGER_KEYS = (*RECORD_CREATED_KEYS, *PATCH_KEYS, *SCHEDULE_KEYS)
PH_ACTION_LIMIT = 4.4  # Below the 4.6 legal limit for acidified foods (research §6).
OEE_REVIEW = 55
REORDER_TOTES = 6
VARIANCE_REVIEW = 500
BREAKDOWN_MINUTES = 30


def _ref(
    module_key: str,
    fields: Mapping[str, Mapping[str, str]],
    field_key: str,
    module_ids: Mapping[str, str],
) -> dict[str, str]:
    return {"moduleId": module_ids[module_key], "fieldId": fields[module_key][field_key]}


def build_triggers(
    organization: OrganizationPack,
    seed: int,
    module_ids: Mapping[str, str],
    field_ids: Mapping[str, Mapping[str, str]],
) -> list[dict[str, object]]:
    def option(module: str, field: str, value: str) -> str:
        return _option_id(seed, module, field, value, organization)

    def condition(module: str, field: str, operator: str, value: JsonValue) -> dict[str, object]:
        return {
            "id": _doc_id(seed, "condition", f"{module}:{field}:{operator}:{value}", organization),
            "field": _ref(module, field_ids, field, module_ids),
            "operator": operator,
            "value": {"kind": "literal", "value": value},
        }

    def event(kind: str, module: str, **values: object) -> dict[str, object]:
        return {"kind": kind, "moduleId": module_ids[module], **values}

    def rule(
        key: str,
        name: str,
        module: str,
        trigger: dict[str, object],
        conditions: list[dict[str, object]],
        target: str,
        value: JsonValue = True,
        *,
        enabled: bool = True,
    ) -> dict[str, object]:
        return {
            "id": _doc_id(seed, "trigger", key, organization),
            "name": name,
            "enabled": enabled,
            "priority": len(key),
            "trigger": trigger,
            "conditionGroup": {"operator": "all", "conditions": conditions},
            "actions": [
                {
                    "id": _doc_id(seed, "action", key, organization),
                    "kind": "set-field",
                    "target": _ref(module, field_ids, target, module_ids),
                    "value": {"kind": "literal", "value": value},
                }
            ],
        }

    def threshold(module: str, field: str, operator: str, value: float) -> dict[str, object]:
        return event("threshold-crossed", module, fieldId=field_ids[module][field],
                     operator=operator, value={"kind": "literal", "value": value})  # fmt: skip

    lots, ncrs, downtime = "material_lots", "ncrs", "downtime_events"
    batches, reports, materials = "batch_records", "shift_reports", "materials"
    invoices, orders = "supplier_invoices", "maintenance_work_orders"
    return [
        rule(RECORD_CREATED_KEYS[0], "Flag a rejected receipt for an NCR", lots,
             event("record-created", lots),
             [condition(lots, "status", "=", option(lots, "status", "Rejected"))],
             "ncr_required"),
        rule(RECORD_CREATED_KEYS[1], "Flag a critical nonconformance for a CAPA", ncrs,
             event("record-created", ncrs),
             [condition(ncrs, "severity", "=", option(ncrs, "severity", "Critical"))],
             "capa_required"),
        rule(RECORD_CREATED_KEYS[2], "Flag a breakdown of 30 minutes or more for a work order",
             downtime, event("record-created", downtime),
             [condition(downtime, "loss_category", "=",
                        option(downtime, "loss_category", "Breakdown")),
              condition(downtime, "duration_min", ">=", BREAKDOWN_MINUTES)],
             "mwo_required"),
        rule(PATCH_KEYS[0], "Put a batch above pH 4.40 on QA hold", batches,
             threshold(batches, "equilibrium_ph", ">", PH_ACTION_LIMIT),
             [condition(batches, "equilibrium_ph", ">", PH_ACTION_LIMIT)],
             "status", option(batches, "status", "QA hold")),
        rule(PATCH_KEYS[1], "Flag a shift below 55% OEE for review", reports,
             threshold(reports, "oee_pct", "<", OEE_REVIEW),
             [condition(reports, "oee_pct", "<", OEE_REVIEW)], "needs_review"),
        rule(PATCH_KEYS[2], "Flag paste totes below 6 on hand for reorder", materials,
             threshold(materials, "on_hand", "<", REORDER_TOTES),
             [condition(materials, "uom", "=", option(materials, "uom", "tote"))],
             "reorder_needed"),
        rule(PATCH_KEYS[3], "Send a price variance over $500 to match review", invoices,
             threshold(invoices, "price_variance", ">", VARIANCE_REVIEW),
             [condition(invoices, "price_variance", ">", VARIANCE_REVIEW)], "match_exception"),
        rule(SCHEDULE_KEYS[0], "Review work orders waiting on parts weekly", orders,
             event("schedule", orders, frequency="weekly", time="06:00", weekday=1),
             [condition(orders, "status", "=", option(orders, "status", "Waiting parts"))],
             "parts_review", enabled=False),
    ]  # fmt: skip
