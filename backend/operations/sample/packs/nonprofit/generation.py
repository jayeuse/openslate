"""Deterministic foundation record values, including the named part-payment cases."""

from __future__ import annotations

import random
from collections.abc import Callable, Mapping
from datetime import date

from operations.sample.actors import assignee_key
from operations.sample.blueprint import (
    NamedCalculationCheck,
    NamedFieldCheck,
    NamedRelationshipCheck,
    NamedScenario,
    _option_id,
)
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.nonprofit import figures, ledger, links, text
from operations.sample.packs.nonprofit.links import PINNED, status
from operations.sample.packs.nonprofit.people import TEAM_KEYS
from operations.sample.packs.nonprofit.timeline import business_day
from operations.sample.packs.nonprofit.values import choice_label
from operations.sample.packs.types import OMIT, FieldSpec, JsonValue, ModuleSpec
from operations.sample.realism import DIRT, dirty_text, dirty_value

NAMED_SCENARIOS = (
    NamedScenario(
        key="pledge-part-payment",
        name="First installment on a scholarship pledge",
        record_ids=("pledges:000001", "donations:000001"),
        expected={"pledge_total": 120_000, "payment_amount": 30_000, "balance_due": 90_000},
        field_checks=(
            NamedFieldCheck("pledges:000001", "total_amount", "pledge_total"),
            NamedFieldCheck("pledges:000001", "balance_due", "balance_due"),
            NamedFieldCheck("donations:000001", "amount", "payment_amount"),
        ),
        relationship_checks=(
            NamedRelationshipCheck("pledge_donations", "pledges:000001", "donations:000001"),
        ),
        calculation_checks=(
            NamedCalculationCheck("balance_due", "subtract", ("pledge_total", "payment_amount")),
        ),
    ),
    NamedScenario(
        key="advance-part-liquidation",
        name="Training advance liquidated in part",
        record_ids=("cash_advances:000001", "expense_lines:000001", "expense_lines:000002",
                    "expense_lines:000003"),  # fmt: skip
        expected={"released": 25_000, "liquidated": 18_750, "unliquidated": 6_250,
                  "receipt_1": 9_500, "receipt_2": 6_000, "receipt_3": 3_250},  # fmt: skip
        field_checks=(
            NamedFieldCheck("cash_advances:000001", "amount_released", "released"),
            NamedFieldCheck("cash_advances:000001", "amount_liquidated", "liquidated"),
            NamedFieldCheck("cash_advances:000001", "balance", "unliquidated"),
            NamedFieldCheck("expense_lines:000001", "amount", "receipt_1"),
            NamedFieldCheck("expense_lines:000002", "amount", "receipt_2"),
            NamedFieldCheck("expense_lines:000003", "amount", "receipt_3"),
        ),
        relationship_checks=tuple(
            NamedRelationshipCheck("advance_expenses", "cash_advances:000001",
                                   f"expense_lines:00000{line}")
            for line in (1, 2, 3)
        ),  # fmt: skip
        calculation_checks=(
            NamedCalculationCheck("liquidated", "add", ("receipt_1", "receipt_2", "receipt_3")),
            NamedCalculationCheck("unliquidated", "subtract", ("released", "liquidated")),
        ),
    ),
)

_PROGRAMS = TEAM_KEYS["programs"]
# People named in User fields; each one reads the module (they write or read it).
_USERS: dict[tuple[str, str], tuple[str, ...]] = {
    ("pledges", "solicitor"): TEAM_KEYS["resource_mobilization"][:2],
    ("grant_awards", "grant_manager"): TEAM_KEYS["grants_partnerships"][:2],
    ("grant_reports", "preparer"): TEAM_KEYS["grants_partnerships"][1:3],
    ("grant_reports", "reviewer"): TEAM_KEYS["grants_partnerships"][:1],
    ("projects", "manager"): _PROGRAMS[:2],
    ("activities", "facilitator"): _PROGRAMS[2:],
    ("beneficiaries", "registered_by"): _PROGRAMS[2:],
    ("assistance", "delivered_by"): _PROGRAMS[1:],
    ("indicator_results", "verified_by"): TEAM_KEYS["meal"][:2],
    ("cash_advances", "approved_by"): _PROGRAMS[:2],
    ("expense_lines", "checked_by"): TEAM_KEYS["finance"][1:2],
    ("disbursements", "prepared_by"): TEAM_KEYS["finance"][2:3],
    ("disbursements", "approved_by"): TEAM_KEYS["finance"][:1],
    ("purchase_requests", "requested_by"): (*_PROGRAMS[1:3], TEAM_KEYS["procurement"][1]),
    ("purchase_requests", "approved_by"): _PROGRAMS[:1],
    ("purchase_orders", "received_by"): TEAM_KEYS["procurement"][2:],
    ("volunteers", "coordinator"): TEAM_KEYS["volunteer_engagement"],
}
_UNAPPROVED = frozenset({"Draft", "Submitted", "Requested", "For approval", "Budget checked",
                         "Returned", "Rejected"})  # fmt: skip


def _user(module: ModuleSpec, field: FieldSpec, index: int, state: str) -> str | object:
    if field.key == "custodian":
        return f"@user:{text.custodian(index)}"
    if field.key == "approved_by" and state in _UNAPPROVED:
        return OMIT
    team = _USERS[(module.key, field.key)]
    return f"@user:{team[0] if index < PINNED else team[(index * 7 + 3) % len(team)]}"


def _clean_field_value(
    organization: OrganizationPack,
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> JsonValue | object:
    kind, key = field.value_kind, module.key
    state = status(key, index, counts)
    if kind == "status":
        if state == field.default_value and index % 5 == 0:
            return OMIT
        return _option_id(seed, key, field.key, state, organization)
    if field.type == "Select":
        label = choice_label(module, field, index, counts, state)
        return OMIT if label is None else _option_id(seed, key, field.key, label, organization)
    if kind == "title":
        if key == "indicator_results":
            indicator = links.result_slot(index, counts)[0]
            period = figures.period_label(index, anchor, counts)
            return f"{text.indicator_code(indicator)} — {period}"
        return text.record_title(key, index, seed, counts)
    if kind == "reference":
        return text.reference_code(key, index, seed) or OMIT
    if kind == "owner":
        return f"@user:{assignee_key(key, module.department, index, seed, organization)}"
    if field.type == "User":
        return _user(module, field, index, state)
    if kind == "flag":
        return False
    if kind == "notes":
        if index % 9 == 0 and index:
            return ""
        return text.note_text(key, field.key, index, seed)
    if field.type == "Date":
        if kind == "birth_date":
            return figures.birth_date(index, seed, anchor)
        day = business_day(key, field.key, index, seed, anchor, counts)
        return OMIT if day is None else day.isoformat()
    if kind == "phone":
        return text.phone_value(index, seed)
    if kind == "email":
        if key in {"donors", "volunteers"} and random.Random(f"{seed}:{key}:{index}:email") \
                .random() < 0.3:  # fmt: skip
            return OMIT  # Many people give only a mobile number.
        return text.email_value(key, index, seed, counts)
    if kind == "url":
        if links.org_role(index) in {"Implementing partner", "Coordination"} and index % 2:
            return OMIT
        return text.url_value(key, index, seed)
    value = _MONEY.get((key, field.key))
    if value is not None:
        result = value(index, counts)
        return OMIT if result is None else result
    return figures.field_value(module, field, index, seed, anchor, counts, state)


_MONEY: dict[tuple[str, str], Callable[[int, Mapping[str, int]], int | float | None]] = {
    ("donations", "amount"): ledger.donation_amount,
    ("pledges", "total_amount"): ledger.pledge_total,
    ("pledges", "amount_paid"): ledger.pledge_paid,
    ("pledges", "balance_due"): ledger.pledge_balance,
    ("campaigns", "raised"): ledger.campaign_raised,
    ("campaigns", "goal"): lambda index, _counts: ledger.campaign_goal(index),
    ("grant_awards", "amount_requested"): lambda index, _counts: ledger.amount_requested(index),
    ("grant_awards", "amount_awarded"): ledger.amount_awarded,
    ("budget_lines", "approved"): lambda index, _counts: ledger.line_approved(index),
    ("budget_lines", "actual_to_date"): ledger.line_actual,
    ("budget_lines", "committed"): lambda index, _counts: ledger.line_committed(index),
    ("budget_lines", "burn_rate"): ledger.burn_rate,
    ("funds", "budget"): ledger.fund_budget,
    ("funds", "spent"): ledger.fund_spent,
    ("funds", "available"): lambda index, counts: ledger.money(
        ledger.fund_budget(index, counts) - float(ledger.fund_spent(index, counts))),
    ("cash_advances", "amount_released"): lambda index, _counts: ledger.advance_released(index),
    ("cash_advances", "amount_liquidated"): ledger.advance_liquidated,
    ("cash_advances", "balance"): ledger.advance_balance,
    ("expense_lines", "amount"): ledger.expense_amount,
    ("disbursements", "amount"): ledger.disbursement_amount,
    ("purchase_requests", "estimated_cost"): lambda index, _counts: ledger.request_estimate(index),
    ("purchase_orders", "amount"): ledger.order_amount,
}  # fmt: skip


def _field_value(
    organization: OrganizationPack,
    module: ModuleSpec,
    field: FieldSpec,
    index: int,
    seed: int,
    anchor: date,
    counts: Mapping[str, int],
) -> JsonValue | object:
    """The value as people type it (spec R6, R7); pinned records stay exact."""
    value = _clean_field_value(organization, module, field, index, seed, anchor, counts)
    if index < PINNED or value is OMIT or field.value_kind not in _DIRTY_KINDS:
        return value
    kind = field.value_kind
    previous = index - 1 >= PINNED
    if kind == "title" and module.key in _NEAR_DUPLICATE_MODULES and index >= 2 * PINNED:
        rng = random.Random(f"{seed}:{module.key}:{index}:near-duplicate")
        if rng.random() < 0.03:
            other = _clean_field_value(organization, module, field, index - 7, seed, anchor, counts)
            if isinstance(other, str):
                return dirty_text(rng, other)
    note = (_clean_field_value(organization, module, field, index - 1, seed, anchor, counts)
            if kind == "notes" and previous else None)  # fmt: skip
    return dirty_value(
        random.Random(f"{seed}:{module.key}:{index}:{field.key}:dirt"),
        kind,
        value,
        required=field.required,
        country_code="63",
        quick_entry=random.Random(f"{seed}:{module.key}:{index}:quick").random() < DIRT.quick_entry,
        previous_note=note if isinstance(note, str) else None,
    )


_DIRTY_KINDS = frozenset({"title", "notes", "phone", "email", "url"})
# Named things where a second, slightly different entry for the same one appears.
_NEAR_DUPLICATE_MODULES = frozenset({"suppliers", "donors"})
