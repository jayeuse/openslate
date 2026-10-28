"""Eight distributor flag rules; the weekly A-item count review is published disabled.

The research's create-record automations become a flag on the same record plus a planned
human step (plan rule 5): a receipt posted with a discrepancy is flagged for a short-delivery
claim that the claims officer files; an invoice 30 days past due is flagged for a follow-up
that the collector logs. Status changes stay with people, so rules set checkboxes only.
"""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample.blueprint import _option_id
from operations.sample.catalog import _doc_id
from operations.sample.packs.fmcg_distributor.catalog_fields import NEAR_EXPIRY
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.types import JsonValue

RECORD_CREATED_KEYS = (
    "large-credit-order-check",
    "large-po-approval",
    "count-variance-recount",
)
PATCH_KEYS = (
    "receipt-discrepancy-claim",
    "near-expiry-alert",
    "invoice-past-due-follow-up",
    "van-cash-shortage",
)
SCHEDULE_KEYS = ("weekly-a-item-count",)
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

    def threshold(module: str, field: str, operator: str, value: int) -> dict[str, object]:
        return event("threshold-crossed", module, fieldId=field_ids[module][field],
                     operator=operator, value={"kind": "literal", "value": value})  # fmt: skip

    def rule(
        key: str,
        name: str,
        module: str,
        trigger: dict[str, object],
        conditions: list[dict[str, object]],
        target: str,
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
                    "value": {"kind": "literal", "value": True},
                }
            ],
        }

    def changed(module: str, field: str, label: str) -> tuple[dict[str, object], dict[str, object]]:
        trigger = event("field-changed", module, fieldId=field_ids[module][field])
        return trigger, condition(module, field, "=", option(module, field, label))

    posted, discrepancy = changed("goods_receipts", "status", "Posted with discrepancy")
    banded, near_expiry = changed("stock_lots", "expiry_band", NEAR_EXPIRY)
    cash = option("sales_orders", "payment_terms", "Cash on delivery")
    return [
        rule(RECORD_CREATED_KEYS[0], "Flag a large credit order for a credit check",
             "sales_orders", event("record-created", "sales_orders"),
             [condition("sales_orders", "order_total", ">=", 50_000),
              condition("sales_orders", "payment_terms", "!=", cash)],
             "credit_check_required"),
        rule(RECORD_CREATED_KEYS[1], "Flag a purchase order of ₱500,000 or more for approval",
             "purchase_orders", event("record-created", "purchase_orders"),
             [condition("purchase_orders", "po_total", ">=", 500_000)], "approval_required"),
        rule(RECORD_CREATED_KEYS[2], "Flag a count variance over 2% for a recount",
             "stock_counts", event("record-created", "stock_counts"),
             [condition("stock_counts", "variance_pct", ">", 2),
              condition("stock_counts", "variance_pct", "<", -2)],
             "recount_required", operator="any"),
        rule(PATCH_KEYS[0], "Flag a receipt posted with a discrepancy for a claim",
             "goods_receipts", posted, [discrepancy], "claim_required"),
        rule(PATCH_KEYS[1], "Flag a lot that moves into near expiry", "stock_lots", banded,
             [near_expiry], "near_expiry_alert"),
        rule(PATCH_KEYS[2], "Flag an invoice more than 30 days past due for a follow-up",
             "sales_invoices", threshold("sales_invoices", "days_past_due", ">", 30),
             [condition("sales_invoices", "days_past_due", ">", 30)], "followup_required"),
        rule(PATCH_KEYS[3], "Flag a van tour short by more than ₱500 for review",
             "route_tours", threshold("route_tours", "cash_variance", "<", -500),
             [condition("route_tours", "cash_variance", "<", -500)], "variance_review"),
        rule(SCHEDULE_KEYS[0], "Review the A-item counts every Monday", "stock_counts",
             event("schedule", "stock_counts", frequency="weekly", time="07:00", weekday=1),
             [condition("stock_counts", "count_type", "=",
                        option("stock_counts", "count_type", "Cycle A"))],
             "weekly_review", enabled=False),
    ]  # fmt: skip
