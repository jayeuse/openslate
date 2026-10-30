"""Eight supported Clinic flag rules, with the weekly maintenance review disabled.

The research's create-record automations become a flag on the same record plus a planned
human step (plan rule 5): a finished visit is flagged ready to claim and a claims
specialist creates the claim; a fridge excursion flags an incident report that the quality
officer files; a lot below 20 flags a reorder; a device out of service flags a work order.
"""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample.blueprint import _option_id
from operations.sample.catalog import _doc_id
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.types import JsonValue

RECORD_CREATED_KEYS = (
    "critical-result-callback",
    "fridge-excursion-incident",
    "severe-incident-root-cause",
)
PATCH_KEYS = (
    "finished-visit-ready-to-claim",
    "denied-claim-work-queue",
    "low-lot-reorder",
    "device-out-of-service-work-order",
)
SCHEDULE_KEYS = ("weekly-maintenance-review",)
TRIGGER_KEYS = (*RECORD_CREATED_KEYS, *PATCH_KEYS, *SCHEDULE_KEYS)


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
                    "value": {"kind": "literal", "value": True},
                }
            ],
        }

    def status_changed(module: str, label: str) -> tuple[dict[str, object], dict[str, object]]:
        trigger = event("field-changed", module, fieldId=field_ids[module]["status"])
        return trigger, condition(module, "status", "=", option(module, "status", label))

    visit, visit_finished = status_changed("encounters", "Finished")
    claim, claim_denied = status_changed("claims", "Denied")
    device, device_down = status_changed("equipment", "Out of service")
    return [
        rule(RECORD_CREATED_KEYS[0], "Flag a critical result for a call-back", "lab_results",
             event("record-created", "lab_results"),
             [condition("lab_results", "flag", "=",
                        option("lab_results", "flag", "Critical high"))],
             "callback_required"),
        rule(RECORD_CREATED_KEYS[1], "Flag a fridge excursion for an incident report",
             "temperature_logs", event("record-created", "temperature_logs"),
             [condition("temperature_logs", "max_c", ">", 8)], "incident_required"),
        rule(RECORD_CREATED_KEYS[2], "Flag a severe incident for root-cause analysis",
             "incident_reports", event("record-created", "incident_reports"),
             [condition("incident_reports", "harm", "=",
                        option("incident_reports", "harm", "Severe"))], "rca_required"),
        rule(PATCH_KEYS[0], "Mark a finished visit ready to claim", "encounters", visit,
             [visit_finished], "claim_required"),
        rule(PATCH_KEYS[1], "Send a denied claim to the denials queue", "claims", claim,
             [claim_denied], "denial_queue"),
        rule(PATCH_KEYS[2], "Flag a lot below 20 units for reorder", "stock_lots",
             event("threshold-crossed", "stock_lots",
                   fieldId=field_ids["stock_lots"]["qty_on_hand"], operator="<",
                   value={"kind": "literal", "value": 20}),
             [condition("stock_lots", "qty_on_hand", "<", 20)], "reorder_required"),
        rule(PATCH_KEYS[3], "Flag a device out of service for a work order", "equipment",
             device, [device_down], "work_order_required"),
        rule(SCHEDULE_KEYS[0], "Review preventive maintenance weekly",
             "maintenance_work_orders",
             event("schedule", "maintenance_work_orders", frequency="weekly", time="06:30",
                   weekday=1),
             [condition("maintenance_work_orders", "wo_type", "=",
                        option("maintenance_work_orders", "wo_type", "Preventive maintenance"))],
             "review_required", enabled=False),
    ]  # fmt: skip
