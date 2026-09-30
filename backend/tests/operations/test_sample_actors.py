"""Planned record creators and assignees follow real access and look like team work."""

from __future__ import annotations

from collections import Counter
from datetime import date
from itertools import groupby

from operations.sample_catalog import _MODULES
from operations.sample_people import _GROUP_ACCESS, _people
from operations.sample_scenario import build_dataset

_LEVELS = {"read": 1, "write": 2, "manage": 3}


def _level(person_key: str, department: str, module: str) -> int:
    """Highest level across groups; a module row beats its department row within a group."""
    person = next(item for item in _people() if item.key == person_key)
    if person.role == "guest":
        return 0
    best = 0
    for group in person.groups:
        rows = _GROUP_ACCESS[group]
        module_rows = [level for dept, mod, level in rows if dept == department and mod == module]
        dept_rows = [level for dept, mod, level in rows if dept == department and mod is None]
        chosen = module_rows or dept_rows
        if chosen:
            best = max(best, _LEVELS[chosen[0]])
    return best


def test_every_planned_creator_can_write_the_module() -> None:
    dataset = build_dataset("standard", seed=42, anchor_date=date(2026, 9, 30))
    active = {person.key for person in _people() if person.status == "active"}
    for record in dataset.records:
        assert record.creator_key in active
        department = next(
            module.department for module in _MODULES if module.key == record.module_key
        )
        assert _level(record.creator_key, department, record.module_key) >= _LEVELS["write"]


def test_creators_work_in_short_sessions_and_rotate() -> None:
    dataset = build_dataset("standard", seed=42, anchor_date=date(2026, 9, 30))
    for module in _MODULES:
        creators = [
            record.creator_key for record in dataset.records if record.module_key == module.key
        ]
        runs = [len(list(group)) for _, group in groupby(creators)]
        # A run can merge two sessions only if the same person was drawn twice in a row,
        # which the plan prevents, so every run is one session of two to six records.
        assert all(1 <= size <= 6 for size in runs), module.key
        assert all(size >= 2 for size in runs[:-1]), module.key


def test_everyone_on_a_team_creates_records_and_leads_create_fewer() -> None:
    dataset = build_dataset("standard", seed=42, anchor_date=date(2026, 9, 30))
    creators = Counter(record.creator_key for record in dataset.records)
    internal_active = {
        person.key for person in _people() if person.role == "member" and person.status == "active"
    }
    assert set(creators) == internal_active
    for team in ("sales", "service", "field", "inventory", "purchasing", "finance"):
        lead = creators[f"internal_{team}_lead"]
        members = [creators[f"internal_{team}_{index:02d}"] for index in range(2, 6)]
        assert lead < min(members), team


def test_assignees_are_team_members_and_owner_values_name_them() -> None:
    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 30))
    owner_fields = {
        field["id"]
        for module in dataset.document["design"]["modules"]
        for field in module["fields"]
        if field["type"] == "User"
    }
    for record in dataset.records:
        department = next(
            module.department for module in _MODULES if module.key == record.module_key
        )
        assert record.assignee_key.startswith(f"internal_{department}_")
        owners = [value for key, value in record.data.items() if key in owner_fields]
        assert owners == [f"@user:{record.assignee_key}"]


def test_internal_audit_group_gives_two_sales_members_read_only_finance_access() -> None:
    audit = [person.key for person in _people() if "internal-audit" in person.groups]
    assert audit == ["internal_sales_04", "internal_sales_05"]
    for key in audit:
        assert _level(key, "finance", "invoices") == _LEVELS["read"]
        assert _level(key, "purchasing", "purchase_orders") == _LEVELS["read"]


def test_audit_rows_must_name_the_planned_person() -> None:
    from operations.sample_verification import expected_edge_actor, expected_record_actor

    dataset = build_dataset("small", seed=42, anchor_date=date(2026, 9, 30))
    record = dataset.records[0]
    ids = {key: f"user-{key}" for key in {item.creator_key for item in dataset.records}}
    assert expected_record_actor(record, ids) == f"user-{record.creator_key}"
    # A link is expected from whoever created the child record, never from the parent's creator.
    child = next(item for item in dataset.records if item.creator_key != record.creator_key)
    assert expected_edge_actor(child, ids) == f"user-{child.creator_key}"
    assert expected_edge_actor(None, ids) == ""
    assert expected_record_actor(record, {}) == ""
