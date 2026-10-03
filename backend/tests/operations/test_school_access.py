"""School people and access grants preserve the current authorization rules."""

from __future__ import annotations

from collections.abc import Mapping

from operations.sample_packs import get_pack
from operations.sample_packs.interface import OrganizationPack
from operations.sample_packs.types import PersonSpec, RejectionCase

_LEVEL_RANK = {None: 0, "read": 1, "write": 2, "manage": 3}


def _person(pack: OrganizationPack, key: str) -> PersonSpec:
    return next(person for person in pack.actors.people if person.key == key)


def _module_level(
    pack: OrganizationPack, actor_key: str, department: str, module: str
) -> str | None:
    """Resolve the pack's declared rows with the application's documented group rules."""
    person = _person(pack, actor_key)
    levels: list[str] = []
    for group in person.groups:
        rows = pack.actors.group_access[group]
        module_rows = [
            level
            for row_department, row_module, level in rows
            if row_department == department and row_module == module
        ]
        department_rows = [
            level
            for row_department, row_module, level in rows
            if row_department == department and row_module is None
        ]
        selected = module_rows or department_rows
        if selected:
            levels.append(selected[0])
    if not levels:
        return None
    highest = max(levels, key=_LEVEL_RANK.__getitem__)
    return "read" if person.role == "guest" else highest


def _department_level(pack: OrganizationPack, actor_key: str, department: str) -> str | None:
    person = _person(pack, actor_key)
    levels = [
        level
        for group in person.groups
        for row_department, module, level in pack.actors.group_access[group]
        if row_department == department and module is None
    ]
    if not levels:
        return None
    highest = max(levels, key=_LEVEL_RANK.__getitem__)
    return "read" if person.role == "guest" else highest


def _cases(pack: OrganizationPack) -> Mapping[str, RejectionCase]:
    return {
        case.key: case for case in (*pack.rejections.activity_cases, *pack.rejections.closing_cases)
    }


def test_school_people_and_access_groups_match_the_department_teams() -> None:
    pack = get_pack("school")
    people = {person.key: person for person in pack.actors.people}

    assert set(pack.actors.team_keys) == set(pack.actors.department_keys)
    assert set(pack.actors.team_groups) == set(pack.actors.department_keys)
    assert len({person.email for person in pack.actors.people}) == len(pack.actors.people)
    for department, actor_keys in pack.actors.team_keys.items():
        assert len(actor_keys) >= 2
        assert len(pack.actors.team_roster[department]) == len(actor_keys)
        assert len(pack.actors.team_titles[department]) == len(actor_keys)
        for key in actor_keys:
            person = people[key]
            assert person.role == "member"
            assert person.status == "active"
            assert pack.actors.team_groups[department] in person.groups
            assert "school-staff" in person.groups

    guest = _person(pack, "guest_auditor")
    sponsor = people[guest.sponsor or ""]
    assert guest.role == "guest"
    assert guest.status == "active"
    assert sponsor.role == "member" and sponsor.status == "active"
    assert _person(pack, "internal_pending_01").status == "pending"
    assert _person(pack, "internal_disabled_01").status == "disabled"


def test_school_grants_preserve_finance_separation_and_sensitive_module_limits() -> None:
    pack = get_pack("school")

    assert _module_level(pack, "internal_finance_03", "finance", "payments") == "manage"
    assert _module_level(pack, "internal_finance_03", "finance", "fee_assessments") == "read"
    assert _module_level(pack, "internal_finance_03", "finance", "fee_adjustments") == "read"
    assert _module_level(pack, "internal_finance_04", "finance", "payments") == "read"
    assert _module_level(pack, "internal_finance_04", "finance", "fee_adjustments") == "manage"

    assert _module_level(pack, "internal_academic_03", "academic", "students") == "read"
    assert _module_level(pack, "internal_academic_03", "health", "health_alerts") is None
    assert _module_level(pack, "internal_academic_03", "health", "clinic_visits") is None
    assert _module_level(pack, "internal_academic_03", "student_affairs", "guidance_cases") is None
    assert _module_level(pack, "internal_academic_03", "finance", "fee_assessments") is None
    assert (
        _module_level(pack, "internal_student_affairs_02", "student_affairs", "guidance_cases")
        is None
    )
    assert (
        _module_level(pack, "internal_student_affairs_lead", "student_affairs", "guidance_cases")
        == "read"
    )
    assert (
        _module_level(pack, "internal_student_affairs_03", "student_affairs", "guidance_cases")
        == "manage"
    )

    auditor = _module_level(pack, "guest_auditor", "finance", "payments")
    assert auditor == "read"
    assert _LEVEL_RANK[auditor] < _LEVEL_RANK["write"]
    assert all(
        not (
            {
                department
                for department, module, level in rows
                if module is None and level == "manage"
            }
            == set(pack.actors.department_keys)
        )
        for rows in pack.actors.group_access.values()
    )
    assert pack.actors.group_access["school-staff"] == ()

    for department, actor_keys in pack.actors.team_keys.items():
        lead = actor_keys[0]
        assert _department_level(pack, lead, department) == "manage"


def test_school_refusals_match_the_declared_actor_grants_and_operations() -> None:
    pack = get_pack("school")
    cases = _cases(pack)

    expected = {
        "teacher_opens_fee_assessment": ("internal_academic_03", 404, "fee_assessments:000001"),
        "teacher_opens_clinic_visit": ("internal_academic_03", 404, "clinic_visits:000001"),
        "cashier_approves_fee_adjustment": ("internal_finance_03", 403, "fee_adjustments:000002"),
        "bursar_records_payment": ("internal_finance_04", 403, "payments:000002"),
        "guest_auditor_edits_payment": ("guest_auditor", 403, "payments:000003"),
    }
    for key, (actor, status, logical_id) in expected.items():
        case = cases[key]
        assert case.actor_key == actor
        assert case.expected_status == status
        module = logical_id.split(":", maxsplit=1)[0]
        department = next(item.department for item in pack.catalog.modules if item.key == module)
        assert _LEVEL_RANK[_module_level(pack, actor, department, module)] < _LEVEL_RANK["write"]
        if status == 404:
            assert case.operation == "read-record"
            assert case.target_record_id == logical_id
            assert logical_id in case.needs
        elif key == "cashier_approves_fee_adjustment":
            assert case.operation == "edit-record"
            assert case.target_record_id == logical_id
            assert logical_id in case.needs
        elif key == "guest_auditor_edits_payment":
            assert case.operation == "edit-record"
            assert case.target_record_id == logical_id
            assert logical_id in case.needs
        else:
            assert case.operation == "create-record"
            assert case.template_record_id == logical_id

    for key in (
        "missing_required_field",
        "unknown_select_option",
        "wrong_value_type",
        "unknown_field",
    ):
        assert cases[key].expected_status == 422

    assert cases["duplicate_student_class_section"].expected_status == 409
    assert cases["duplicate_student_class_section"].relationship_key == "student_roster"
    assert cases["second_class_section_report_card_batch"].expected_status == 409
    assert (
        cases["second_class_section_report_card_batch"].relationship_key == "section_report_cards"
    )
    assert cases["stale_group_edit"].expected_status == 412
    assert cases["stale_post_edit"].expected_status == 409
    assert cases["pending_account_sign_in"].expected_status == 401
    assert cases["disabled_account_sign_in"].expected_status == 401
