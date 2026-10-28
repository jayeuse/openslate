"""Pack record and date chains that must remain coherent across deterministic seeds."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from datetime import date
from importlib import import_module
from typing import Any, cast

from operations.sample.actors import planned_access_level
from operations.sample.blueprint import SampleDataset, SampleRecord
from operations.sample.client import _SAFE_MAPPING_VALUE
from operations.sample.history import status_label
from operations.sample.packs.interface import OrganizationPack
from operations.sample.packs.phase_types import PhaseAction
from operations.sample.packs.types import JsonValue
from operations.sample.phases.plan import (
    phase_action_to_manifest,
    plan_phases,
)
from operations.sample.phases.plan import (
    phase_expected_projection as phase_expected_projection,
)
from operations.sample.population.boards import project_board_logical_id
from tests.operations.sample.packs.sample_pack_openview_preflight import (
    validate_phase_request_payloads,
)

_ACCESS_LEVELS = {"read": 1, "write": 2, "manage": 3}

_HARBOR_DATE_ORDER = (
    ("quotes", "sent_at", "activity_date"),
    ("sales_orders", "activity_date", "promised_at"),
    ("service_contracts", "signed_at", "activity_date"),
    ("service_requests", "requested_at", "activity_date"),
    ("work_orders", "scheduled_at", "activity_date"),
    ("purchase_orders", "confirmed_at", "activity_date"),
    ("invoices", "issued_at", "activity_date"),
    ("expenses", "activity_date", "submitted_at"),
)
_HARBOR_SAME_DAY = (
    ("goods_receipts", "activity_date", "received_at"),
    ("payments", "activity_date", "posted_at"),
    ("credit_notes", "activity_date", "issued_at"),
)
_HARBOR_LINKED_DATES = (
    ("invoice_payments", "invoices", "issued_at", "payments", "activity_date"),
    ("invoice_credits", "invoices", "issued_at", "credit_notes", "activity_date"),
    ("request_updates", "service_requests", "requested_at", "request_updates", "activity_date"),
    (
        "purchase_order_receipts",
        "purchase_orders",
        "confirmed_at",
        "goods_receipts",
        "activity_date",
    ),
    ("work_order_inspections", "work_orders", "scheduled_at", "inspections", "activity_date"),
)
_HARBOR_PAST_DATES = (
    ("payments", "posted_at"),
    ("goods_receipts", "received_at"),
    ("request_updates", "activity_date"),
    ("inspections", "activity_date"),
    ("service_requests", "requested_at"),
    ("invoices", "issued_at"),
    ("purchase_orders", "confirmed_at"),
)


def _value(dataset: SampleDataset, record: SampleRecord, field_key: str) -> JsonValue:
    return record.data[dataset.field_ids[record.module_key][field_key]]


def _day(value: JsonValue) -> date:
    if not isinstance(value, str):
        raise AssertionError(f"Expected an ISO date value, got {value!r}")
    return date.fromisoformat(value[:10])


def _number(value: JsonValue) -> int | float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise AssertionError("Named scenario calculations require numeric inputs")
    return value


def _validate_named_scenarios(dataset: SampleDataset) -> None:
    records = {record.logical_id: record for record in dataset.records}
    actual_edges = {
        (edge.relationship_id, edge.source_record_id, edge.target_record_id)
        for edge in dataset.edges
    }
    for scenario in dataset.named_scenarios:
        for field_check in scenario.field_checks:
            record = records[field_check.logical_record_id]
            field_id = dataset.field_ids[record.module_key][field_check.field_key]
            assert record.data[field_id] == scenario.expected[field_check.expected_key]
        for relationship_check in scenario.relationship_checks:
            assert (
                dataset.relationship_ids[relationship_check.relationship_key],
                relationship_check.source_record_id,
                relationship_check.target_record_id,
            ) in actual_edges
        for calculation_check in scenario.calculation_checks:
            operands = [_number(scenario.expected[key]) for key in calculation_check.operand_keys]
            expected = _number(scenario.expected[calculation_check.expected_key])
            if calculation_check.operator == "subtract":
                actual = operands[0] - operands[1]
            else:
                assert calculation_check.operator == "add"
                actual = sum(operands)
            assert actual == expected


def _validate_harbor_dates(dataset: SampleDataset) -> None:
    records_by_id = {record.logical_id: record for record in dataset.records}
    for module_key, earlier_key, later_key in _HARBOR_DATE_ORDER:
        records = [item for item in dataset.records if item.module_key == module_key]
        pairs = [
            (_day(_value(dataset, item, earlier_key)), _day(_value(dataset, item, later_key)))
            for item in records
        ]
        assert pairs and all(earlier <= later for earlier, later in pairs)
    for module_key, first_key, second_key in _HARBOR_SAME_DAY:
        records = [item for item in dataset.records if item.module_key == module_key]
        pairs = [
            (_day(_value(dataset, item, first_key)), _day(_value(dataset, item, second_key)))
            for item in records
        ]
        assert pairs and all(first == second for first, second in pairs)

    for (
        relation_key,
        parent_module,
        parent_field,
        child_module,
        child_field,
    ) in _HARBOR_LINKED_DATES:
        edges = [
            edge
            for edge in dataset.edges
            if edge.relationship_id == dataset.relationship_ids[relation_key]
        ]
        assert edges
        for edge in edges:
            assert edge.source_record_id.startswith(f"{parent_module}:")
            assert edge.target_record_id.startswith(f"{child_module}:")
            assert _day(
                _value(dataset, records_by_id[edge.source_record_id], parent_field)
            ) <= _day(_value(dataset, records_by_id[edge.target_record_id], child_field))
    for module_key, field_key in _HARBOR_PAST_DATES:
        for record in dataset.records:
            if record.module_key == module_key:
                assert _day(_value(dataset, record, field_key)) <= dataset.anchor_date


def _validate_school_dates(dataset: SampleDataset) -> None:
    records_by_id = {record.logical_id: record for record in dataset.records}
    past_due = [
        record
        for record in dataset.records
        if record.module_key == "fee_assessments"
        and status_label(dataset, record.module_key, record.data) == "Past due"
    ]
    for record in past_due:
        assert _day(_value(dataset, record, "next_due_date")) < dataset.anchor_date
    for record in dataset.records:
        if record.module_key == "payments":
            assert _day(_value(dataset, record, "payment_date")) <= dataset.anchor_date

    inquiry_edges = [
        edge
        for edge in dataset.edges
        if edge.relationship_id == dataset.relationship_ids["inquiry_applications"]
    ]
    assert inquiry_edges
    for edge in inquiry_edges:
        assert _day(_value(dataset, records_by_id[edge.source_record_id], "inquiry_date")) <= _day(
            _value(dataset, records_by_id[edge.target_record_id], "submitted_on")
        )
    for record in dataset.records:
        if record.module_key == "applications":
            assert _day(_value(dataset, record, "submitted_on")) <= _day(
                _value(dataset, record, "entrance_test_on")
            )

    clinic_arrival = _day(_value(dataset, records_by_id["clinic_visits:000001"], "time_in"))
    attendance_followup = _day(
        _value(dataset, records_by_id["attendance_exceptions:000006"], "activity_date")
    )
    assert clinic_arrival <= attendance_followup <= dataset.anchor_date


def validate_record_chain_consistency(dataset: SampleDataset) -> None:
    """Check named business totals/links and existing pack-specific temporal chains."""
    _validate_named_scenarios(dataset)
    if dataset.organization.identity.key == "harbor":
        _validate_harbor_dates(dataset)
    elif dataset.organization.identity.key == "school":
        _validate_school_dates(dataset)
    else:
        # A later pack keeps its chain rules in sample_pack_<key>_chain.validate_dates.
        key = dataset.organization.identity.key
        try:
            rules = import_module(f"tests.operations.sample.packs.sample_pack_{key}_chain")
        except ModuleNotFoundError:
            raise AssertionError(f"No record/date chain admission rules for {key}") from None
        rules.validate_dates(dataset)


def _updated_pack(
    pack: OrganizationPack,
    people: Mapping[str, Any],
    group_access: Mapping[str, tuple[tuple[str, str | None, str], ...]],
) -> OrganizationPack:
    return replace(
        pack,
        actors=replace(
            pack.actors,
            people=tuple(people[person.key] for person in pack.actors.people),
            group_access=dict(group_access),
        ),
    )


def _board_access_level(pack: OrganizationPack, person_key: str, department_key: str) -> int:
    person = next(item for item in pack.actors.people if item.key == person_key)
    if person.status != "active":
        return 0
    if person.role == "admin":
        return 3
    levels = [
        _ACCESS_LEVELS[level]
        for group, level in (
            *pack.content.data.project_groups,
            pack.content.data.department_groups[department_key],
        )
        if group in person.groups
    ]
    level = max(levels, default=0)
    return min(level, 1) if person.role == "guest" else level


def _project_targets(pack: OrganizationPack) -> dict[str, str]:
    return {
        project_board_logical_id(department, name): department
        for name, department in pack.content.data.projects
    }


def _validate_phase_actor_access(dataset: SampleDataset, actions: tuple[PhaseAction, ...]) -> None:
    """Replay plan mutations and check each actor before the next action."""
    pack = dataset.organization
    people = {person.key: person for person in pack.actors.people}
    original_groups = {key: set(person.groups) for key, person in people.items()}
    groups = {key: set(value) for key, value in original_groups.items()}
    group_access = dict(pack.actors.group_access)
    ended_sessions: set[str] = set()
    board_status = dict.fromkeys(_project_targets(pack), "active")
    purged_board_previews: set[str] = set()
    openview_archived: set[str] = set()
    seen_reorganization = False

    for action in actions:
        assert action.phase in {"admin", "reorganization"}
        if action.phase == "reorganization":
            seen_reorganization = True
        else:
            assert not seen_reorganization, "Admin actions must precede reorganization actions"

        if action.actor_key == "admin":
            assert action.actor_key not in ended_sessions
            actor = None
        else:
            assert action.actor_key in people, (action.key, action.actor_key)
            actor = people[action.actor_key]
            assert actor.status == "active", (action.key, actor.key, actor.status)
            assert actor.email.strip() and actor.username.strip(), (action.key, actor.key)
            assert actor.key not in ended_sessions, (action.key, actor.key)

        kind = action.kind
        if kind == "refuse_role_change":
            assert actor is not None and actor.role in {"member", "guest"}
            assert action.expected_status == 403 and action.expected_detail == "Forbidden"
        elif kind == "refuse_board_archive":
            department = _project_targets(pack)[action.target_key]
            assert board_status[action.target_key] == "active"
            assert actor is not None and actor.role in {"member", "guest"}
            assert (
                _board_access_level(
                    _updated_pack(pack, people, group_access), actor.key, department
                )
                == 2
            )
            assert action.expected_status == 403 and action.expected_detail == "Forbidden"
        elif kind in {"openview_archive", "openview_restore"}:
            resource_kind = str(action.values["resource_kind"])
            department = str(action.values["department_key"])
            module_key = None if resource_kind == "dashboard" else str(action.values["module_key"])
            assert actor is not None
            current_pack = _updated_pack(pack, people, group_access)
            assert planned_access_level(current_pack, actor.key, department, module_key) == 3, (
                action.key,
                actor.key,
                department,
                module_key,
            )
            if kind == "openview_archive":
                assert action.target_key not in openview_archived
                openview_archived.add(action.target_key)
            else:
                assert action.target_key in openview_archived
                openview_archived.remove(action.target_key)
        elif kind in {"board_archive", "board_restore"}:
            department = _project_targets(pack)[action.target_key]
            if actor is None:
                assert action.actor_key == "admin"
            else:
                assert (
                    _board_access_level(
                        _updated_pack(pack, people, group_access), actor.key, department
                    )
                    >= 3
                )
            if kind == "board_archive":
                assert board_status[action.target_key] == "active"
                board_status[action.target_key] = "archived"
            else:
                assert board_status[action.target_key] == "archived"
                board_status[action.target_key] = "active"
        elif kind in {
            "promote_user",
            "demote_user",
            "remove_group_member",
            "add_group_member",
            "replace_group_access",
            "disable_user",
            "restore_disabled_user",
            "end_session",
            "board_create_purge_target",
            "board_archive_purge_target",
            "board_purge_preview",
            "board_purge",
            "sandbox_edit_publish",
            "sandbox_close_empty_publish",
            "sandbox_reopen_empty_publish",
            "sandbox_restore_publish",
        }:
            assert action.actor_key == "admin", (action.key, action.actor_key)

        if kind == "promote_user":
            target = people[action.target_key]
            removed = set(cast(list[str], action.values["removed_group_keys"]))
            assert target.status == "active" and target.role == "member" and target.groups
            assert removed == groups[action.target_key]
            groups[action.target_key].difference_update(removed)
            people[action.target_key] = replace(target, role="admin", groups=())
        elif kind == "demote_user":
            target = people[action.target_key]
            assert target.role == "admin" and not groups[action.target_key]
            people[action.target_key] = replace(target, role=str(action.values["role"]))
        elif kind == "remove_group_member":
            group_key = str(action.values["source_group_key"])
            assert group_key in groups[action.target_key]
            groups[action.target_key].remove(group_key)
            people[action.target_key] = replace(
                people[action.target_key], groups=tuple(sorted(groups[action.target_key]))
            )
        elif kind == "add_group_member":
            group_key = str(action.values["destination_group_key"])
            assert group_key not in groups[action.target_key]
            groups[action.target_key].add(group_key)
            people[action.target_key] = replace(
                people[action.target_key], groups=tuple(sorted(groups[action.target_key]))
            )
        elif kind == "replace_group_access":
            assert action.target_key in group_access
            current_rows = [
                {"department_key": department, "module_key": module, "level": level}
                for department, module, level in group_access[action.target_key]
            ]
            assert current_rows == action.values["before_access"]
            new_rows = cast(list[dict[str, Any]], action.values["access"])
            group_access[action.target_key] = tuple(
                (
                    str(row["department_key"]),
                    str(row["module_key"]) if row["module_key"] is not None else None,
                    str(row["level"]),
                )
                for row in new_rows
            )
        elif kind == "disable_user":
            target = people[action.target_key]
            assert target.status == "active"
            people[action.target_key] = replace(target, status="disabled")
        elif kind == "restore_disabled_user":
            target = people[action.target_key]
            assert target.status == "disabled"
            people[action.target_key] = replace(target, status="active")
        elif kind == "end_session":
            session_target = str(action.values["person_key"])
            assert session_target == action.target_key and session_target not in ended_sessions
            assert people[session_target].status == "active"
            ended_sessions.add(session_target)
        elif kind == "board_create_purge_target":
            purge_board_target = action.target_key
            name = str(action.values["name"])
            department = str(action.values["department_key"])
            assert purge_board_target not in board_status
            assert project_board_logical_id(department, name) == purge_board_target
            assert department in pack.actors.department_keys
            assert all(existing_name != name for existing_name, _ in pack.content.data.projects)
            board_status[purge_board_target] = "active"
        elif kind == "board_archive_purge_target":
            assert board_status[action.target_key] == "active"
            board_status[action.target_key] = "archived"
        elif kind == "board_purge_preview":
            assert board_status[action.target_key] == "archived"
            assert action.target_key not in purged_board_previews
            purged_board_previews.add(action.target_key)
        elif kind == "board_purge":
            assert board_status[action.target_key] == "archived"
            assert action.target_key in purged_board_previews
            board_status[action.target_key] = "purged"

    assert not openview_archived
    assert ended_sessions
    original_boards = _project_targets(pack)
    assert all(status == "active" for key, status in board_status.items() if key in original_boards)
    assert all(
        status == "purged" for key, status in board_status.items() if key not in original_boards
    )

    final_pack = _updated_pack(pack, people, group_access)
    projection = phase_expected_projection(actions)
    projected_people = cast(dict[str, dict[str, object]], projection["people"])
    for key, state in projected_people.items():
        for field in ("role", "status"):
            if field in state:
                assert getattr(people[key], field) == state[field]

    actual_memberships = {
        (group, person_key)
        for person_key, person_groups in groups.items()
        for group in person_groups
    }
    initial_memberships = {
        (group, person_key)
        for person_key, person_groups in original_groups.items()
        for group in person_groups
    }
    assert sorted(actual_memberships - initial_memberships) == projection["membership_additions"]
    assert sorted(initial_memberships - actual_memberships) == projection["membership_removals"]

    projected_access = cast(dict[str, list[dict[str, object]]], projection["group_access"])
    for group_key, rows in projected_access.items():
        actual_rows = [
            {"department_key": department, "module_key": module, "level": level}
            for department, module, level in final_pack.actors.group_access[group_key]
        ]
        assert actual_rows == rows
    projected_boards = cast(dict[str, dict[str, object]], projection["boards"])
    for board_key, expected in projected_boards.items():
        assert board_status[board_key] == expected["status"]
    projected_openview = cast(dict[str, dict[str, object]], projection["openview"])
    for target_key, expected in projected_openview.items():
        assert target_key not in openview_archived
        assert expected["is_deleted"] is False
    assert ended_sessions == {
        row["person_key"] for row in cast(list[dict[str, object]], projection["ended_sessions"])
    }


def validate_phase_plan_consistency(dataset: SampleDataset) -> None:
    """Admit typed phase bodies, actor state transitions, journal keys, and final documents."""
    original_records = tuple(dataset.records)
    original_edges = tuple(dataset.edges)
    actions = plan_phases(dataset)
    assert actions
    assert tuple(dataset.records) == original_records
    assert tuple(dataset.edges) == original_edges

    manifests = [phase_action_to_manifest(action) for action in actions]
    keys = [str(row["key"]) for row in manifests]
    assert len(keys) == len(set(keys))
    assert all(_SAFE_MAPPING_VALUE.fullmatch(key) for key in keys)
    _validate_phase_actor_access(dataset, actions)
    versions = validate_phase_request_payloads(dataset, actions)
    projection = cast(dict[str, Any], phase_expected_projection(actions))
    final_design = cast(dict[str, Any], projection["design"])
    assert final_design["new_module_id"] == next(
        action.values["new_module_id"]
        for action in actions
        if action.kind == "sandbox_edit_publish"
    )
    assert final_design["edited_version_key"] == "phase_design_edited"
    assert final_design["open_version_key"] == "phase_design_open"
    assert final_design["final_version_key"] == "phase_design_restored"
    assert final_design["new_module_closed"] is False
    assert versions["phase_design_restored"] == versions["phase_design_open"]
