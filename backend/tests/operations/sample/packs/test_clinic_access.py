"""Clinic access is minimum-necessary: each team reads only what its work names."""

from __future__ import annotations

import pytest

from operations.sample.actors import planned_access_level
from operations.sample.packs.clinic import PACK

_MODULE_DEPARTMENT = {module.key: module.department for module in PACK.catalog.modules}


def _level(person: str, module: str) -> int:
    return planned_access_level(PACK, person, _MODULE_DEPARTMENT[module], module)


@pytest.mark.parametrize(
    ("person", "module", "level"),
    [
        ("internal_patient_access_03", "lab_results", 0),  # Front desk: the result is hidden.
        ("internal_revenue_cycle_03", "encounters", 1),  # Claims specialist reads the visit.
        ("internal_clinical_03", "lab_results", 1),  # A nurse reads results; the lab finalizes.
        ("internal_operations_03", "patients", 0),  # Storekeeper: no patient module.
        ("guest_surveyor", "staff_credentials", 1),  # A guest surveyor reads only.
        ("internal_laboratory_02", "lab_results", 2),
        ("internal_revenue_cycle_04", "payments", 2),
    ],
)
def test_plan_refusal_actors_hold_exactly_the_planned_level(
    person: str, module: str, level: int
) -> None:
    assert _level(person, module) == level


def test_visit_results_and_prescriptions_stay_closed_to_wide_groups_and_guests() -> None:
    sensitive = ("encounters", "lab_results", "prescriptions", "specimens", "patients")
    outsiders = [
        person.key
        for person in PACK.actors.people
        if person.status == "active"
        and (person.role == "guest" or any(group in person.groups for group in
                                           ("operations-supply", "quality-office")))
    ]  # fmt: skip
    assert outsiders
    assert {(person, module): _level(person, module)
            for person in outsiders for module in sensitive} == dict.fromkeys(
        ((person, module) for person in outsiders for module in sensitive), 0)  # fmt: skip
    # Revenue reads the visit it bills, but no result or prescription.
    assert [_level("internal_revenue_cycle_02", key) for key in sensitive[:3]] == [1, 0, 0]


def test_guests_read_only_modules_that_are_safe_to_show_in_full() -> None:
    guests = [person for person in PACK.actors.people if person.role == "guest"]
    readable = {
        (person.key, module)
        for person in guests
        for module in _MODULE_DEPARTMENT
        if _level(person.key, module)
    }
    assert readable == {
        ("guest_surveyor", "staff_credentials"),
        ("guest_biomed", "equipment"),
        ("guest_biomed", "maintenance_work_orders"),
    }
