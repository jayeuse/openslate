"""Deterministic sauce plant record values, including the named invoice part payment."""

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
from operations.sample.packs.manufacturer import details, money, notes, states, text
from operations.sample.packs.manufacturer import plan_base as base
from operations.sample.packs.manufacturer import plan_plant as plant
from operations.sample.packs.manufacturer.people import TEAM_KEYS
from operations.sample.packs.manufacturer.plan_base import PINNED
from operations.sample.packs.manufacturer.relations import reference_parents
from operations.sample.packs.manufacturer.values import choice_label
from operations.sample.packs.types import OMIT, FieldSpec, JsonValue, ModuleSpec
from operations.sample.realism import DIRT, dirty_text, dirty_value

NAMED_SCENARIOS = (
    NamedScenario(
        key="invoice-part-payment",
        name="Part payment on a retail customer invoice",
        record_ids=("customer_invoices:000001", "customer_payments:000001"),
        expected={
            "invoice_amount": money.SCENARIO_TOTAL,
            "payment_amount": money.SCENARIO_PAID,
            "balance": money.SCENARIO_BALANCE,
        },
        field_checks=(
            NamedFieldCheck("customer_invoices:000001", "amount", "invoice_amount"),
            NamedFieldCheck("customer_invoices:000001", "balance", "balance"),
            NamedFieldCheck("customer_payments:000001", "amount", "payment_amount"),
        ),
        relationship_checks=(
            NamedRelationshipCheck(
                "invoice_payments", "customer_invoices:000001", "customer_payments:000001"
            ),
        ),
        calculation_checks=(
            NamedCalculationCheck("balance", "subtract", ("invoice_amount", "payment_amount")),
        ),
    ),
)


def _team(department: str, *positions: int) -> tuple[str, ...]:
    return tuple(TEAM_KEYS[department][position] for position in positions)


# Each User field names a person who reads the module (the server refuses anyone else),
# and stays empty until the step it records has happened.
_USERS: dict[tuple[str, str], tuple[str, ...]] = {
    ("sales_orders", "entered_by"): _team("sales", 1, 3, 0),
    ("boms", "bom_approver"): _team("quality", 0, 3),
    ("purchase_orders", "buyer"): _team("planning", 2, 3, 0),
    ("production_orders", "planner"): _team("planning", 1, 0),
    ("material_lots", "receiver"): _team("warehouse", 1, 0),
    ("material_lots", "inspector"): _team("quality", 1, 3),
    ("shipments", "shipper"): _team("warehouse", 2, 3, 0),
    ("batch_records", "batch_maker"): _team("manufacturing", 2, 3, 1),
    ("batch_records", "batch_qa"): _team("quality", 1, 3),
    ("shift_reports", "line_lead"): _team("manufacturing", 2, 1),
    ("downtime_events", "reporter"): _team("manufacturing", 2, 3, 1),
    ("finished_goods_lots", "releaser"): _team("quality", 1, 0),
    ("food_safety_logs", "checker"): _team("quality", 1, 3, 2),
    ("food_safety_logs", "verifier"): _team("quality", 0, 2),
    ("maintenance_work_orders", "technician"): _team("maintenance", 2, 3),
    ("supplier_invoices", "ap_clerk"): _team("finance", 2, 0),
}
_NOT_YET: dict[tuple[str, str], frozenset[str]] = {
    ("boms", "bom_approver"): frozenset({"Draft", "Pending approval"}),
    ("material_lots", "inspector"): frozenset({"Quarantine"}),
    ("shipments", "shipper"): frozenset({"Planned", "Picking"}),
    ("batch_records", "batch_qa"): frozenset({"Weighing", "Cooking", "Awaiting QA"}),
    ("finished_goods_lots", "releaser"): frozenset({"QA hold, awaiting release"}),
    ("food_safety_logs", "verifier"): frozenset({"Open", "Completed", "Deviation"}),
    ("maintenance_work_orders", "technician"): frozenset({"Requested", "Approved", "Cancelled"}),
}


def _user(key: str) -> str:
    return f"@user:{key}"


def _pick(pool: tuple[str, ...], module: str, index: int, field: str) -> str:
    """Mostly the first person in the pool: the team's usual signatory."""
    if index < PINNED:
        return pool[0]
    stream = random.Random(f"mfg:{module}:{index}:{field}:person")
    return stream.choices(pool, weights=[3**-position for position in range(len(pool))])[0]


def _person(
    organization: OrganizationPack, module: ModuleSpec, field: FieldSpec, index: int, seed: int,
    status: str,
) -> JsonValue | object:  # fmt: skip
    if field.value_kind == "owner":
        return _user(assignee_key(module.key, module.department, index, seed, organization))
    slot = (module.key, field.value_kind)
    if status in _NOT_YET.get(slot, frozenset()):
        return OMIT
    readers = _USERS.get(slot)
    if readers is None:
        raise ValueError(f"No reader pool for sauce plant field {module.key}.{field.key}")
    return _user(_pick(readers, module.key, index, field.key))


def _boolean(module: str, field: str, index: int, counts: Mapping[str, int], status: str) -> bool:
    roll = random.Random(f"mfg:{module}:{index}:{field}:check").random()
    if field == "acidified":
        return base.product_line(index)[3]
    if field == "coa_received":
        return index != 0 and roll < 0.96
    if field == "seal_intact":
        return roll < 0.98
    if field == "trailer_ok":
        return status != "Refused" or roll < 0.5
    if field == "rework_added":
        return index >= PINNED and roll < 0.03
    if field == "within_limit":
        return not plant.log_deviation(index)
    if field == "sanitation_signoff":
        return status in {"Completed", "Closed"} and roll < 0.9
    if field == "three_way_match":
        return status in {"Matched", "Approved", "Paid"}
    raise ValueError(f"Unsupported sauce plant checkbox {module}.{field}")


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
    status = states.status_label(key, index, counts)
    if kind == "status":
        if status == field.default_value and index % 5 == 0:
            return OMIT
        return _option_id(seed, key, field.key, status, organization)
    if field.type == "User":
        return _person(organization, module, field, index, seed, status)
    if field.type == "Select":
        label = choice_label(module, field, index, counts, status)
        return OMIT if label is None else _option_id(seed, key, field.key, label, organization)
    if field.type in {"Date", "Date/Time"}:
        value = details.date_value(module, field, index, anchor, counts, status)
        if value is None:
            return OMIT
        return value if isinstance(value, str) else value.isoformat()
    if kind == "title":
        return text.record_title(key, index, seed, counts)
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
        return _boolean(key, field.key, index, counts, status)
    if kind == "notes":
        return notes.note(key, index, seed, counts, status)
    if kind == "email":
        if key == "suppliers" and base.supplier_category(index) == "Service" and index % 2:
            return OMIT
        return text.email_value(key, index, seed, counts)
    if kind == "phone":
        return text.phone_value(index, seed, key)
    if kind == "url":
        return OMIT if index % 4 == 3 else text.url_value(key, index, seed)
    return details.detail_value(module, field, index, seed, anchor, counts, status)


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
        country_code="1",
        quick_entry=random.Random(f"{seed}:{module.key}:{index}:quick").random() < DIRT.quick_entry,
        previous_note=note if isinstance(note, str) else None,
    )


_DIRTY_KINDS = frozenset({"title", "notes", "phone", "email", "url"})
# Named things where a second, slightly different entry for the same company appears.
_NEAR_DUPLICATE_MODULES = frozenset({"customers", "suppliers"})
