"""Eight supported city government Set-field rules, with the weekly materials review disabled.

The research's create-record automations become a flag on the same record plus a planned
human step (plan rule 5): an assessed application is flagged for an order of payment that
the assessor issues; a failed inspection flags a notice the inspector drafts; an ordinance
approved on third reading flags the transmittal the clerk sends to the mayor.
"""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample.blueprint import _option_id
from operations.sample.catalog import _doc_id
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.types import JsonValue

RECORD_CREATED_KEYS = (
    "drainage-request-priority",
    "failed-inspection-notice",
    "delayed-registration-posting",
)
PATCH_KEYS = (
    "assessed-application-payment-order",
    "complex-permit-sla-breach",
    "large-request-competitive-bidding",
    "third-reading-transmittal",
)
SCHEDULE_KEYS = ("weekly-materials-hold-review",)
TRIGGER_KEYS = (*RECORD_CREATED_KEYS, *PATCH_KEYS, *SCHEDULE_KEYS)
COMPETITIVE_BIDDING_ABC = 2_000_000  # Above the small value cap of a first-class city.


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
        operator: str = "all",
        enabled: bool = True,
    ) -> dict[str, object]:
        return {
            "id": _doc_id(seed, "trigger", key, organization),
            "name": name,
            "enabled": enabled,
            "priority": len(key),
            "trigger": trigger,
            "conditionGroup": {"operator": operator, "conditions": conditions},
            "actions": [
                {
                    "id": _doc_id(seed, "action", key, organization),
                    "kind": "set-field",
                    "target": _ref(module, field_ids, target, module_ids),
                    "value": {"kind": "literal", "value": value},
                }
            ],
        }

    def status_changed(module: str, label: str) -> tuple[dict[str, object], dict[str, object]]:
        trigger = event("field-changed", module, fieldId=field_ids[module]["status"])
        return trigger, condition(module, "status", "=", option(module, "status", label))

    def threshold(module: str, field: str, operator: str, value: int) -> dict[str, object]:
        return event("threshold-crossed", module, fieldId=field_ids[module][field],
                     operator=operator, value={"kind": "literal", "value": value})  # fmt: skip

    requests = "service_requests"
    assessed, assessed_condition = status_changed("permit_applications", "Assessed")
    reading, reading_condition = status_changed("legislative_measures", "Approved on third reading")
    return [
        rule(RECORD_CREATED_KEYS[0], "Raise drainage and flooding requests to high priority",
             requests, event("record-created", requests),
             [condition(requests, "service_type", "=",
                        option(requests, "service_type", "Clogged drainage or canal")),
              condition(requests, "service_type", "=",
                        option(requests, "service_type", "Street flooding"))],
             "priority", option(requests, "priority", "High"), operator="any"),
        rule(RECORD_CREATED_KEYS[1], "Flag a failed inspection for a notice of violation",
             "business_inspections", event("record-created", "business_inspections"),
             [condition("business_inspections", "status", "=",
                        option("business_inspections", "status", "Failed"))],
             "notice_required"),
        rule(RECORD_CREATED_KEYS[2], "Flag a delayed registration for the 10-day posting",
             "civil_registry", event("record-created", "civil_registry"),
             [condition("civil_registry", "timeliness", "=",
                        option("civil_registry", "timeliness", "Delayed"))],
             "posting_required"),
        rule(PATCH_KEYS[0], "Flag an assessed application for its order of payment",
             "permit_applications", assessed, [assessed_condition], "oop_required"),
        rule(PATCH_KEYS[1], "Mark a complex permit past 7 working days as breached",
             "building_permits", threshold("building_permits", "days_pending", ">", 7),
             [condition("building_permits", "days_pending", ">", 7),
              condition("building_permits", "complexity", "=",
                        option("building_permits", "complexity", "Complex"))],
             "sla_flag", option("building_permits", "sla_flag", "Breached")),
        rule(PATCH_KEYS[2], "Recommend competitive bidding above the small value cap",
             "purchase_requests",
             threshold("purchase_requests", "abc_amount", ">=", COMPETITIVE_BIDDING_ABC),
             [condition("purchase_requests", "abc_amount", ">=", COMPETITIVE_BIDDING_ABC)],
             "recommended_mode",
             option("purchase_requests", "recommended_mode", "Competitive bidding")),
        rule(PATCH_KEYS[3], "Flag a measure approved on third reading for transmittal",
             "legislative_measures", reading, [reading_condition], "transmittal_required"),
        rule(SCHEDULE_KEYS[0], "Review work orders on hold for materials weekly", "work_orders",
             event("schedule", "work_orders", frequency="weekly", time="07:00", weekday=1),
             [condition("work_orders", "status", "=",
                        option("work_orders", "status", "On hold for materials"))],
             "materials_review", enabled=False),
    ]  # fmt: skip
