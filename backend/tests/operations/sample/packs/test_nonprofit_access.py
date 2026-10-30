"""Fairhaven access is need-to-know: each team reads only what its work names."""

from __future__ import annotations

import pytest

from operations.sample.actors import planned_access_level
from operations.sample.packs.nonprofit import PACK

_MODULE_DEPARTMENT = {module.key: module.department for module in PACK.catalog.modules}


def _level(person: str, module: str) -> int:
    return planned_access_level(PACK, person, _MODULE_DEPARTMENT[module], module)


@pytest.mark.parametrize(
    ("person", "module", "level"),
    [
        ("internal_programs_03", "donations", 1),  # A project officer reads gifts only.
        ("internal_programs_04", "feedback_cases", 0),  # Safeguarding cases stay hidden.
        ("internal_procurement_02", "disbursements", 0),  # Buyers never see payments.
        ("guest_funder", "indicator_results", 1),  # The funder guest reads only.
        ("internal_programs_02", "budget_lines", 1),  # Programs cannot raise a budget.
        ("internal_finance_02", "budget_lines", 1),
        ("internal_executive_office_02", "feedback_cases", 2),
        ("internal_resource_mobilization_03", "donations", 2),
    ],
)
def test_plan_refusal_actors_hold_exactly_the_planned_level(
    person: str, module: str, level: int
) -> None:
    assert _level(person, module) == level


def test_safeguarding_cases_are_read_only_by_the_executive_office() -> None:
    readers = {
        person.key
        for person in PACK.actors.people
        if person.status == "active" and _level(person.key, "feedback_cases")
    }
    assert readers == {"internal_executive_office_lead", "internal_executive_office_02",
                       "internal_executive_office_03"}  # fmt: skip


def test_resource_mobilization_reads_no_beneficiary_record() -> None:
    fundraisers = [person.key for person in PACK.actors.people
                   if "rm-team" in person.groups and person.status == "active"]  # fmt: skip
    assert fundraisers
    assert {_level(key, module) for key in fundraisers
            for module in ("beneficiaries", "assistance")} == {0}  # fmt: skip


def test_guests_read_only_modules_that_are_safe_to_show_in_full() -> None:
    guests = [person for person in PACK.actors.people if person.role == "guest"]
    readable = {
        (person.key, module)
        for person in guests
        for module in _MODULE_DEPARTMENT
        if _level(person.key, module)
    }
    finance = ("funds", "cash_advances", "expense_lines", "disbursements", "suppliers",
               "purchase_requests", "purchase_orders")  # fmt: skip
    assert readable == {
        *(("guest_auditor", module) for module in finance),
        ("guest_funder", "indicators"),
        ("guest_funder", "indicator_results"),
    }
