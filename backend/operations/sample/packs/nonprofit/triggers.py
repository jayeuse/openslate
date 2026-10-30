"""Nine supported foundation flag rules, with the weekly payment run disabled.

The research's create-record automations become a flag on the same record plus a planned
human step (plan rule 5): a newly awarded grant is flagged for fund setup and the grants
accountant opens the Fund; a disputed distribution flags a feedback case that the
accountability officer logs.
"""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample.blueprint import _option_id
from operations.sample.catalog import _doc_id
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.nonprofit.catalog_fields import AWARDED, SAFEGUARDING
from operations.sample.packs.types import JsonValue

MAJOR_GIFT = 50_000  # Pesos: the Executive Director calls to thank the donor.
THREE_QUOTES = 50_000  # Pesos: the procurement manual asks for three quotations.
RECORD_CREATED_KEYS = (
    "major-gift-thank-you-call",
    "missing-consent-follow-up",
    "safeguarding-referral",
    "off-track-result",
    "three-quotes-needed",
)
PATCH_KEYS = (
    "grant-awarded-fund-setup",
    "budget-line-overspend",
    "disputed-distribution-feedback",
    "advance-ready-to-close",
)
SCHEDULE_KEYS = ("weekly-payment-run",)
TRIGGER_KEYS = (*RECORD_CREATED_KEYS, *PATCH_KEYS, *SCHEDULE_KEYS)


def _ref(module_key: str, fields: Mapping[str, Mapping[str, str]], field_key: str,
         module_ids: Mapping[str, str]) -> dict[str, str]:  # fmt: skip
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

    def rule(key: str, name: str, module: str, trigger: dict[str, object],
             conditions: list[dict[str, object]], target: str, *, enabled: bool = True
             ) -> dict[str, object]:  # fmt: skip
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

    def threshold(module: str, field: str, operator: str, value: int) -> dict[str, object]:
        return event("threshold-crossed", module, fieldId=field_ids[module][field],
                     operator=operator, value={"kind": "literal", "value": value})  # fmt: skip

    awarded, grant_awarded = status_changed("grant_awards", AWARDED)
    dispute, disputed = status_changed("assistance", "Disputed")
    return [
        rule(RECORD_CREATED_KEYS[0], "Ask the Executive Director to thank a major donor",
             "donations", event("record-created", "donations"),
             [condition("donations", "amount", ">=", MAJOR_GIFT)], "major_gift_call"),
        rule(RECORD_CREATED_KEYS[1], "Follow up a registration without consent",
             "beneficiaries", event("record-created", "beneficiaries"),
             [condition("beneficiaries", "consent_recorded", "=", False)], "consent_followup"),
        rule(RECORD_CREATED_KEYS[2], "Refer a safeguarding concern to the focal point",
             "feedback_cases", event("record-created", "feedback_cases"),
             [condition("feedback_cases", "category", "=",
                        option("feedback_cases", "category", SAFEGUARDING))],
             "restricted_handling"),
        rule(RECORD_CREATED_KEYS[3], "Flag a result below 70% of target", "indicator_results",
             event("record-created", "indicator_results"),
             [condition("indicator_results", "pct_of_target", "<", 70)], "off_track"),
        rule(RECORD_CREATED_KEYS[4], "Ask for three quotes on a large request",
             "purchase_requests", event("record-created", "purchase_requests"),
             [condition("purchase_requests", "estimated_cost", ">=", THREE_QUOTES)],
             "three_quotes"),
        rule(PATCH_KEYS[0], "Flag a newly awarded grant for fund setup", "grant_awards",
             awarded, [grant_awarded], "fund_setup"),
        rule(PATCH_KEYS[1], "Alert when a budget line passes 90% spent", "budget_lines",
             threshold("budget_lines", "burn_rate", ">=", 90),
             [condition("budget_lines", "burn_rate", ">=", 90)], "overspend_alert"),
        rule(PATCH_KEYS[2], "Flag a disputed distribution for a feedback case", "assistance",
             dispute, [disputed], "feedback_required"),
        rule(PATCH_KEYS[3], "Flag a fully liquidated advance for closing", "cash_advances",
             threshold("cash_advances", "balance", "<=", 0),
             [condition("cash_advances", "balance", "<=", 0)], "ready_to_close"),
        rule(SCHEDULE_KEYS[0], "Collect draft vouchers for the Friday payment run",
             "disbursements",
             event("schedule", "disbursements", frequency="weekly", time="15:00", weekday=5),
             [condition("disbursements", "status", "=",
                        option("disbursements", "status", "Draft"))],
             "payment_run", enabled=False),
    ]  # fmt: skip
