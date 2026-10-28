"""City government access separates the finance signatures and closes the civil registry."""

from __future__ import annotations

import pytest

from operations.sample.actors import planned_access_level
from operations.sample.packs.local_government import PACK

_MODULE_DEPARTMENT = {module.key: module.department for module in PACK.catalog.modules}


def _level(person: str, module: str) -> int:
    return planned_access_level(PACK, person, _MODULE_DEPARTMENT[module], module)


@pytest.mark.parametrize(
    ("person", "module", "level"),
    [
        ("internal_bplo_02", "disbursement_vouchers", 0),  # Licensing officer: hidden.
        ("internal_treasury_03", "payment_orders", 1),  # The collector reads, never assesses.
        ("internal_treasury_03", "official_receipts", 2),
        ("internal_treasury_02", "payment_orders", 2),  # The assessor writes the order.
        ("internal_budget_accounting_03", "payment_releases", 1),  # Accounting reads custody.
        ("internal_treasury_04", "payment_releases", 2),  # The disbursing officer releases.
        ("internal_city_clerk_02", "civil_registry", 0),  # Council clerk: hidden.
        ("internal_city_clerk_04", "civil_registry", 2),  # The registration officer.
        ("guest_state_auditor", "disbursement_vouchers", 1),  # A guest reads only.
    ],
)
def test_refusal_actors_hold_exactly_the_planned_level(
    person: str, module: str, level: int
) -> None:
    assert _level(person, module) == level


def test_only_the_registry_and_the_city_clerk_read_the_civil_registry() -> None:
    readers = {person.key for person in PACK.actors.people if _level(person.key, "civil_registry")}
    assert readers == {"internal_city_clerk_lead", "internal_city_clerk_04"}


def test_each_finance_signature_is_written_by_its_own_office_only() -> None:
    writers = {
        module: {person.key for person in PACK.actors.people if _level(person.key, module) >= 2}
        for module in ("payment_orders", "official_receipts", "payment_releases",
                       "obligation_requests", "disbursement_vouchers")
    }  # fmt: skip
    assert writers == {
        "payment_orders": {"internal_treasury_lead", "internal_treasury_02"},
        "official_receipts": {"internal_treasury_lead", "internal_treasury_03"},
        "payment_releases": {"internal_treasury_lead", "internal_treasury_04"},
        "obligation_requests": {"internal_budget_accounting_lead", "internal_budget_accounting_02"},
        "disbursement_vouchers": {
            "internal_budget_accounting_lead", "internal_budget_accounting_03",
            "internal_budget_accounting_04",
        },
    }  # fmt: skip


def test_guests_read_only_modules_that_are_safe_to_show_in_full() -> None:
    guests = [person for person in PACK.actors.people if person.role == "guest"]
    readable = {
        (person.key, module)
        for person in guests
        for module in _MODULE_DEPARTMENT
        if _level(person.key, module)
    }
    finance = {key for key, department in _MODULE_DEPARTMENT.items()
               if department in {"treasury", "budget_accounting", "procurement"}}  # fmt: skip
    assert readable == {
        *(("guest_state_auditor", module) for module in finance),
        ("guest_fire_inspector", "business_inspections"),
        ("guest_fire_inspector", "building_inspections"),
    }
