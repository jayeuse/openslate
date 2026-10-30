"""Plant access keeps each separated duty in its own module boundary (research §11)."""

from __future__ import annotations

import pytest

from operations.sample.actors import planned_access_level
from operations.sample.packs.manufacturer import PACK

_MODULE_DEPARTMENT = {module.key: module.department for module in PACK.catalog.modules}


def _level(person: str, module: str) -> int:
    return planned_access_level(PACK, person, _MODULE_DEPARTMENT[module], module)


@pytest.mark.parametrize(
    ("person", "module", "level"),
    [
        ("internal_manufacturing_04", "finished_goods_lots", 1),  # Filler operator: reads.
        ("internal_quality_02", "finished_goods_lots", 2),  # QA releases the lot.
        ("internal_manufacturing_02", "ncrs", 1),  # Shift supervisor: no disposition.
        ("internal_manufacturing_03", "ncrs", 0),  # A line lead does not see NCRs.
        ("internal_planning_03", "supplier_invoices", 1),  # The buyer reads, never edits.
        ("internal_finance_03", "supplier_invoices", 2),  # Accounts payable.
        ("internal_finance_02", "supplier_invoices", 1),  # Receivables reads payables.
        ("internal_sales_02", "production_orders", 1),  # Customer service reads the plan.
        ("internal_planning_02", "production_orders", 2),  # The planner owns it.
        ("guest_food_safety_auditor", "capas", 1),  # A guest reads only.
        ("guest_food_safety_auditor", "customer_invoices", 0),  # Hidden from the auditor.
    ],
)
def test_refusal_actors_hold_exactly_the_planned_level(
    person: str, module: str, level: int
) -> None:
    assert _level(person, module) == level


def test_each_separated_duty_is_written_by_its_own_team_only() -> None:
    writers = {
        module: {person.key for person in PACK.actors.people if _level(person.key, module) >= 2}
        for module in ("finished_goods_lots", "supplier_invoices", "customer_invoices",
                       "production_orders")
    }  # fmt: skip
    assert writers == {
        "finished_goods_lots": {
            "internal_quality_lead", "internal_quality_02", "internal_quality_03",
            "internal_quality_04",
        },
        "supplier_invoices": {"internal_finance_lead", "internal_finance_03"},
        "customer_invoices": {"internal_finance_lead", "internal_finance_02"},
        "production_orders": {
            "internal_planning_lead", "internal_planning_02", "internal_planning_03",
            "internal_planning_04",
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
    assert readable == {
        ("guest_food_safety_auditor", "food_safety_logs"),
        ("guest_food_safety_auditor", "capas"),
        ("guest_boiler_contractor", "equipment"),
        ("guest_boiler_contractor", "maintenance_work_orders"),
    }
