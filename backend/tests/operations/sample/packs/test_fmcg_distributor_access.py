"""Silangan access keeps cash custody apart from receivables and guests to safe modules."""

from __future__ import annotations

import pytest

from operations.sample.actors import planned_access_level
from operations.sample.packs.fmcg_distributor import PACK

_MODULE_DEPARTMENT = {module.key: module.department for module in PACK.catalog.modules}


def _level(person: str, module: str) -> int:
    return planned_access_level(PACK, person, _MODULE_DEPARTMENT[module], module)


@pytest.mark.parametrize(
    ("person", "module", "level"),
    [
        ("internal_sales_04", "sales_invoices", 1),  # The van salesman reads invoices only.
        ("internal_sales_03", "credit_reviews", 1),  # A pre-seller cannot approve credit.
        ("internal_purchasing_02", "principal_invoices", 1),  # Buyers cannot clear variances.
        ("internal_logistics_03", "collection_receipts", 0),  # Drivers never see receipts.
        ("guest_principal", "trade_promotions", 1),  # The principal guest reads only.
        ("internal_credit_collections_02", "sales_invoices", 2),
        ("internal_trade_marketing_02", "trade_promotions", 2),
        ("internal_accounting_lead", "purchase_orders", 1),  # The approver reads the PO.
    ],
)
def test_plan_refusal_actors_hold_exactly_the_planned_level(
    person: str, module: str, level: int
) -> None:
    assert _level(person, module) == level


def test_logistics_reads_no_credit_and_collections_record() -> None:
    drivers = [person.key for person in PACK.actors.people
               if "logistics-team" in person.groups and person.status == "active"]  # fmt: skip
    assert drivers
    credit = [key for key, department in _MODULE_DEPARTMENT.items()
              if department == "credit_collections"]  # fmt: skip
    assert {_level(key, module) for key in drivers for module in credit} == {0}


def test_guests_read_only_modules_that_are_safe_to_show_in_full() -> None:
    guests = [person for person in PACK.actors.people if person.role == "guest"]
    readable = {
        (person.key, module)
        for person in guests
        for module in _MODULE_DEPARTMENT
        if _level(person.key, module)
    }
    audited = ("sales_invoices", "collection_receipts", "credit_reviews", "collection_followups",
               "principal_invoices", "principal_claims")  # fmt: skip
    # No principal guest reads the claims, which show every other principal's money.
    assert readable == {
        ("guest_principal", "trade_promotions"),
        ("guest_principal", "products"),
        *(("guest_auditor", module) for module in audited),
    }
