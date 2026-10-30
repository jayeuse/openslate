"""Deterministic city government record values, including the named quarterly installment."""

from __future__ import annotations

import random
from collections.abc import Mapping
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
from operations.sample.packs.local_government import fields, money, states, text, titles
from operations.sample.packs.local_government.links import PINNED
from operations.sample.packs.local_government.people import TEAM_KEYS
from operations.sample.packs.local_government.relations import reference_parents
from operations.sample.packs.local_government.values import choice_label
from operations.sample.packs.types import OMIT, FieldSpec, JsonValue, ModuleSpec
from operations.sample.realism import DIRT, dirty_text, dirty_value

NAMED_SCENARIOS = (
    NamedScenario(
        key="business-tax-installment",
        name="First-quarter installment on a business tax order of payment",
        record_ids=("payment_orders:000001", "official_receipts:000001"),
        expected={
            "amount_due": money.SCENARIO_DUE,
            "receipt_amount": money.SCENARIO_PAID,
            "balance": money.SCENARIO_BALANCE,
        },
        field_checks=(
            NamedFieldCheck("payment_orders:000001", "amount_due", "amount_due"),
            NamedFieldCheck("payment_orders:000001", "balance", "balance"),
            NamedFieldCheck("official_receipts:000001", "amount", "receipt_amount"),
        ),
        relationship_checks=(
            NamedRelationshipCheck(
                "order_receipts", "payment_orders:000001", "official_receipts:000001"
            ),
        ),
        calculation_checks=(
            NamedCalculationCheck("balance", "subtract", ("amount_due", "receipt_amount")),
        ),
    ),
)


def _team(department: str, *positions: int) -> tuple[str, ...]:
    return tuple(TEAM_KEYS[department][position] for position in positions)


# Each User field names a person who reads the module (the server refuses anyone else).
_USERS: dict[tuple[str, str], tuple[str, ...]] = {
    ("permit_applications", "evaluator"): _team("bplo", 2, 1, 0),
    ("business_inspections", "inspector"): _team("bplo", 3, 0),
    ("enforcement_notices", "inspector"): _team("bplo", 3, 1),
    ("building_permits", "evaluator"): _team("building_official", 1, 0),
    ("building_inspections", "inspector"): _team("building_official", 2, 0),
    ("work_orders", "foreman"): _team("public_works", 3, 2),
    ("payment_orders", "assessor"): _team("treasury", 1, 0),
    ("official_receipts", "collector"): _team("treasury", 2, 0),
    ("deposit_reports", "collector"): _team("treasury", 2, 0),
    ("payment_releases", "disbursing"): _team("treasury", 3, 0),
    ("obligation_requests", "budget_officer"): _team("budget_accounting", 1, 0),
    ("disbursement_vouchers", "accountant"): _team("budget_accounting", 2, 3),
    ("procurement_projects", "procurement_officer"): _team("procurement", 2, 1),
    ("acceptance_reports", "inspection_officer"): _team("procurement", 3, 0),
    ("acceptance_reports", "custodian"): _team("procurement", 3),
    ("communications", "action_officer"): _team("city_clerk", 2, 1, 0, 3),
    ("civil_registry", "registrar"): _team("city_clerk", 3, 0),
}
# End-user offices raise purchase requests; the engineers write them, GSO encodes the rest.
_ENGINEERING = frozenset({"City Engineering Office", "City Disaster Risk Reduction Office"})


def _user(key: str) -> str:
    return f"@user:{key}"


def _pick(pool: tuple[str, ...], seed: int, module: str, index: int, field: str) -> str:
    """Mostly the first person in the pool: the office's usual signatory."""
    rng = random.Random(f"{seed}:{module}:{index}:{field}:person")
    weights = [3**-position for position in range(len(pool))]
    return rng.choices(pool, weights=weights)[0] if index >= PINNED else pool[0]


def _person(
    organization: OrganizationPack, module: ModuleSpec, field: FieldSpec, index: int, seed: int,
    status: str,
) -> JsonValue | object:  # fmt: skip
    kind, key = field.value_kind, module.key
    if kind == "owner":
        return _user(assignee_key(key, module.department, index, seed, organization))
    if kind == "requester":
        office = text.procurement_item(index)[1]
        pool = (_team("public_works", 2, 1, 0) if office in _ENGINEERING
                else _team("procurement", 1, 2))  # fmt: skip
        return _user(_pick(pool, seed, key, index, field.key))
    if kind == "evaluator" and status in {"Filed", "Received", "Withdrawn"}:
        return OMIT
    if kind == "budget_officer" and status in {"Filed", "Cancelled"}:
        return OMIT
    if kind == "accountant" and status in {"Received", "Cancelled"}:
        return OMIT
    if kind == "custodian" and status.startswith("Rejected"):
        return OMIT
    if kind == "action_officer" and status in {"Received", "Duplicate"}:
        return OMIT
    if kind == "procurement_officer" and status == "Cancelled":
        return OMIT
    readers = _USERS.get((key, kind))
    if readers is None:
        raise ValueError(f"No reader pool for city government field {key}.{field.key}")
    return _user(_pick(readers, seed, key, index, field.key))


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
    status = states.status_label(key, index, seed, counts)
    if kind == "status":
        if status == field.default_value and index % 5 == 0:
            return OMIT
        return _option_id(seed, key, field.key, status, organization)
    if field.type == "User":
        return _person(organization, module, field, index, seed, status)
    if field.type == "Select":
        days = fields.days_pending(key, index, seed, anchor, counts, status)
        label = choice_label(module, field, index, seed, counts, status, days)
        return OMIT if label is None else _option_id(seed, key, field.key, label, organization)
    if field.type in {"Date", "Date/Time"}:
        value = fields.date_value(module, field, index, seed, anchor, counts, status)
        if value is None:
            return OMIT
        return value if isinstance(value, str) else value.isoformat()
    if kind == "title":
        return titles.record_title(key, index, seed, counts)
    if kind == "reference":
        return text.reference_code(key, index, seed) or OMIT
    if kind == "cross_reference":
        parents = reference_parents(key, field.key, index, counts)
        if not parents:
            return OMIT
        target, target_index = parents[0]
        return text.reference_code(target, target_index, seed) or OMIT
    if kind == "flag":
        return False
    if kind == "boolean":
        if field.key == "reinspection_needed":
            return status in {"Failed, correction required", "Re-inspection scheduled"}
        if field.key == "funds_certified":
            return status not in {"Prepared", "Cancelled"}
        return random.Random(f"{seed}:{key}:{index}:{field.key}").random() < 0.85
    if kind == "notes":
        if index % 9 == 0 and index:
            return ""
        if key == "service_requests" and status in _REQUEST_NOTES:
            earlier = text.reference_code(key, max(0, index - 1 - index % 7), seed)
            return _REQUEST_NOTES[status].format(earlier=earlier)
        return text.note_text(key, field.key, index, seed)
    if kind == "email":
        if key == "business_establishments" and index % 3 == 1:
            return OMIT  # Many small shops give no email address.
        return text.email_value(key, index, seed, counts)
    if kind == "phone":
        if key == "service_requests" and index % 4 == 0:
            return OMIT
        return text.phone_value(index, seed, key)
    if kind == "url":
        return text.url_value(key, index, seed)
    if kind == "days_pending" or kind == "days_since_opening":
        days = fields.days_pending(key, index, seed, anchor, counts, status)
        return OMIT if days is None else days
    return fields.detail_value(module, field, index, seed, anchor, counts, status)


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


_REQUEST_NOTES = {
    "Duplicate": "Duplicate of {earlier}.",
    "Not responsible": "Not LGU jurisdiction, referred to the water district.",
    "Internal referral": "Referred to the office in charge.",
    "Reopened": "Caller says the problem is back.",
}
_DIRTY_KINDS = frozenset({"title", "notes", "phone", "email", "url"})
# Named things where a second, slightly different entry for the same party appears.
_NEAR_DUPLICATE_MODULES = frozenset({"suppliers", "business_establishments"})
