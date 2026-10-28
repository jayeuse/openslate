"""Deterministic distributor record values, including the named invoice part-payment."""

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
from operations.sample.packs.fmcg_distributor import (
    dates,
    figures,
    ledger,
    links,
    links_claims,
    text,
    visits,
)
from operations.sample.packs.fmcg_distributor import links_finance as finance
from operations.sample.packs.fmcg_distributor import people as staff
from operations.sample.packs.fmcg_distributor import vocabulary as words
from operations.sample.packs.fmcg_distributor.links import PINNED
from operations.sample.packs.fmcg_distributor.values import _beat_salesman, choice_label, date_value
from operations.sample.packs.fmcg_distributor.values import status_label as state_of
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.types import OMIT, FieldSpec, JsonValue, ModuleSpec
from operations.sample.realism import DIRT, dirty_text, dirty_value

NAMED_SCENARIOS = (
    NamedScenario(
        key="invoice-part-payment",
        name="Minimart pays part of a 15-day invoice",
        record_ids=("sales_invoices:000001", "collection_receipts:000001"),
        expected={"invoice_amount": ledger.SCENARIO_INVOICE,
                  "payment_amount": ledger.SCENARIO_PAYMENT,
                  "balance": ledger.SCENARIO_BALANCE},  # fmt: skip
        field_checks=(
            NamedFieldCheck("sales_invoices:000001", "amount", "invoice_amount"),
            NamedFieldCheck("sales_invoices:000001", "balance", "balance"),
            NamedFieldCheck("collection_receipts:000001", "amount", "payment_amount"),
        ),
        relationship_checks=(
            NamedRelationshipCheck(
                "invoice_receipts", "sales_invoices:000001", "collection_receipts:000001"
            ),
        ),
        calculation_checks=(
            NamedCalculationCheck("balance", "subtract", ("invoice_amount", "payment_amount")),
        ),
    ),
)

_UNAPPROVED = frozenset({"Draft", "Pending approval", "Rejected", "Cancelled"})


def _user(key: str) -> str:
    return f"@user:{key}"


def _pick(options: tuple[str, ...], index: int) -> str:
    return options[0] if index < PINNED else options[(index * 7 + 3) % len(options)]


def _person(module: ModuleSpec, field: FieldSpec, index: int, counts: Mapping[str, int],
            state: str) -> str | object:  # fmt: skip
    """The person a User field names; every one of them can read the module."""
    kind = field.value_kind
    if kind == "salesman" and module.key == "beats":
        return _user(_beat_salesman(index))
    if kind in {"salesman", "booked_by"}:
        visit = index if module.key == "store_visits" else links.order_visit(index, counts)
        if visit is None:
            channel = links.order_channel(index)
            return _user(staff.KEY_ACCOUNT_KEY if channel == "Key account"
                         else staff.SUPERVISOR_KEY)  # fmt: skip
        if visit >= links.presell_visit_count(counts):
            return _user(_tour_salesman(links.visit_tour(visit, counts)[0]))
        beat = links.outlet_beat(links.visit_outlet(visit, counts), counts)
        return _user(staff.PRE_SELLER_KEY if beat is None else _beat_salesman(beat))
    if kind == "van_salesman":
        return _user(_tour_salesman(index))
    if kind == "raised_by":
        return _user(_pick((staff.PURCHASING_OFFICER_KEY, staff.PURCHASING_OFFICER_KEY,
                            staff.TEAM_KEYS["purchasing"][0]), index))  # fmt: skip
    if kind == "approver":
        if state in _UNAPPROVED:
            return OMIT
        return _user(staff.FINANCE_CONTROLLER_KEY)
    if kind == "received_by":
        return _user(_pick((staff.RECEIVING_CHECKER_KEY, staff.RECEIVING_CHECKER_KEY,
                            staff.TEAM_KEYS["warehouse"][0]), index))  # fmt: skip
    if kind == "counted_by":
        return _user(_pick((staff.RECEIVING_CHECKER_KEY, staff.BO_CLERK_KEY), index))
    if kind == "requested_by":
        return _user(staff.INVENTORY_CONTROLLER_KEY)
    if kind == "reported_by":
        return _user(_pick((staff.PRE_SELLER_KEY, staff.VAN_SALESMAN_KEY, staff.BO_CLERK_KEY,
                            staff.PRE_SELLER_KEY), index))  # fmt: skip
    if kind == "driver":
        return _user(staff.DRIVER_KEY)
    if kind == "collected_by":
        item = finance.receipt(index, counts)
        bill = finance.invoice(item.invoices[0], counts)
        if item.kind == "door":
            return _user(_tour_salesman(bill.source) if bill.kind == "van" else staff.CASHIER_KEY)
        return _user(_pick((staff.COLLECTOR_KEY, staff.CASHIER_KEY, staff.COLLECTOR_KEY), index))
    if kind == "credit_requester":
        return _user(_pick((staff.PRE_SELLER_KEY, staff.SUPERVISOR_KEY, staff.PRE_SELLER_KEY),
                           index))  # fmt: skip
    if kind == "filed_by":
        return _user(_pick((staff.CLAIMS_OFFICER_KEY, staff.CLAIMS_OFFICER_KEY,
                            staff.TEAM_KEYS["accounting"][0]), index))  # fmt: skip
    raise ValueError(f"Unsupported distributor person {module.key}.{field.key}")


def _tour_salesman(tour: int) -> str:
    return staff.SUPERVISOR_KEY if tour >= PINNED and tour % 4 == 3 else staff.VAN_SALESMAN_KEY


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
    state = state_of(key, index, counts)
    if kind == "status":
        if state == field.default_value and index % 5 == 0:
            return OMIT
        return _option_id(seed, key, field.key, state, organization)
    if field.type == "Select":
        label = choice_label(module, field, index, counts)
        return OMIT if label is None else _option_id(seed, key, field.key, label, organization)
    if kind == "title":
        return text.record_title(key, index, seed, counts)
    if kind == "reference":
        return text.reference_code(key, index, seed) or OMIT
    if kind == "owner":
        return _user(assignee_key(key, module.department, index, seed, organization))
    if field.type == "User":
        return _person(module, field, index, counts, state)
    if kind == "flag":
        return False
    if kind == "boolean":
        return ledger.order_has_scheme(index, counts)
    if kind == "notes":
        if index % 9 == 0 and index:
            return ""
        if key == "principal_invoices" and links_claims.match_result(index, counts) in {
            "Quantity variance", "Price variance"}:  # fmt: skip
            return words.VARIANCE_NOTES[index % len(words.VARIANCE_NOTES)]
        return text.note_text(key, field.key, index, seed)
    if field.type == "Date":
        day = date_value(key, kind, index, seed, anchor, counts)
        return OMIT if day is None else day.isoformat()
    if field.type == "Date/Time":
        if visits.visit_status(index, counts) in {"Planned", "Not visited"}:
            return OMIT
        return dates.stamp(dates.visit_date(index, seed, anchor, counts), seed, key, index)
    if kind == "phone":
        return text.phone_value(index, seed)
    if kind == "email":
        return text.email_value(key, index, seed, counts)
    if kind == "url":
        return text.url_value(key, index, seed)
    return figures.number_or_text(kind, key, index, seed, anchor, counts, state)


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
# Named things where a second, slightly different entry for the same outlet appears.
_NEAR_DUPLICATE_MODULES = frozenset({"outlets", "principals"})
