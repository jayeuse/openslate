"""Pack-neutral plan for the Board controls exercised by sample runs."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import timedelta
from decimal import Decimal
from typing import TYPE_CHECKING
from uuid import NAMESPACE_URL, uuid5

from operations.sample.board_text import project_board
from operations.sample.packs.phase_types import PhaseAction, PhaseJsonValue
from operations.sample.phases.actions import PhaseExecutionContext, PhaseSubstep
from operations.sample.population.boards import project_board_logical_id

if TYPE_CHECKING:
    from operations.sample.blueprint import SampleDataset

from operations.sample.controls.board_content import (
    BOARD_CONTENT_ROUTES,
    execute_board_content_action,
)
from operations.sample.controls.board_execution import (
    BOARD_EXECUTION_ROUTES,
    execute_board_action,
)
from operations.sample.controls.board_files import (
    BOARD_FILE_ROUTES,
    FILE_OPERATIONS,
    execute_board_file_action,
    plan_board_file_controls,
)
from operations.sample.controls.board_record_links import (
    BOARD_LINK_ROUTES,
    execute_board_record_link_action,
)
from operations.sample.controls.board_verification import verify_board_controls
from operations.sample.controls.board_widgets import (
    BOARD_WIDGET_ROUTES,
    execute_board_widget_action,
)

_BOARD_ROUTES = frozenset(
    {
        ("GET", "/api/boards/{board_id}"),
        ("PATCH", "/api/boards/{board_id}"),
        ("POST", "/api/boards/{board_id}/duplicate"),
        ("GET", "/api/boards/{board_id}/configuration"),
        ("POST", "/api/boards/import"),
        ("GET", "/api/boards/{board_id}/groups"),
        ("PUT", "/api/boards/{board_id}/groups"),
    }
)
CONTROL_ROUTES = (
    _BOARD_ROUTES
    | BOARD_EXECUTION_ROUTES
    | BOARD_WIDGET_ROUTES
    | BOARD_CONTENT_ROUTES
    | BOARD_LINK_ROUTES
    | BOARD_FILE_ROUTES
)


def _action(
    operation: str,
    suffix: str,
    actor_key: str,
    target_key: str,
    values: Mapping[str, PhaseJsonValue],
    expected_end_state: Mapping[str, PhaseJsonValue],
    *,
    expected_status: int = 200,
) -> PhaseAction:
    return PhaseAction(
        key=f"control:board:{suffix}",
        phase="reorganization",
        kind="board_controls",
        actor_key=actor_key,
        target_key=target_key,
        values={"operation": operation, **values},
        expected_status=expected_status,
        expected_detail=None,
        expected_end_state=dict(expected_end_state),
    )


def _board_manager_and_record(dataset: SampleDataset) -> tuple[str, str, str]:
    pack = dataset.organization
    if pack.phases is None:
        raise ValueError("Board controls require the pack's project Board anchor")
    _, department_key = pack.phases.existing_project_board
    from operations.sample.actors import planned_access_level
    from operations.sample.phases.planning import _board_level

    board_groups = (
        *pack.content.data.project_groups,
        pack.content.data.department_groups[department_key],
    )
    candidates = (pack.content.data.leads[department_key], *pack.actors.team_keys[department_key])
    for actor_key in dict.fromkeys(candidates):
        person = next((item for item in pack.actors.people if item.key == actor_key), None)
        if (
            person is None
            or person.status != "active"
            or person.role != "member"
            or _board_level(pack, actor_key, department_key) < 2
        ):
            continue
        grant_group = next((key for key, _ in board_groups if key in person.groups), None)
        if grant_group is None:
            continue
        record = next(
            (
                item
                for item in dataset.records
                if item.actor_key == department_key
                and planned_access_level(pack, actor_key, department_key, item.module_key) >= 1
            ),
            None,
        )
        if record is not None:
            return actor_key, record.logical_id, grant_group
    raise ValueError("Board controls require a pack writer who can read a local Record")


def plan_board_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    """Plan deterministic Board edits against pack-authored work and a disposable copy."""
    pack = dataset.organization
    phase = pack.phases
    if phase is None:
        return ()
    board_name, department = phase.existing_project_board
    if (board_name, department) not in pack.content.data.projects:
        raise ValueError("The Board control anchor must be an authored pack project")
    source_board_key = project_board_logical_id(department, board_name)
    source_name, description = project_board(board_name, organization=pack)
    if source_name != board_name or not description.strip():
        raise ValueError("The authored Board control anchor is invalid")
    manager, record_key, manager_group = _board_manager_and_record(dataset)
    post_title, post_body = pack.content.data.post_text(
        {"scope": "project", "department_key": department},
        0,
        Decimal(pack.content.data.scenario_total),
        Decimal(pack.content.data.scenario_paid),
    )
    updated_title, updated_body = pack.content.data.revised_post(post_title, post_body)
    event_title = pack.content.data.event_titles[0]
    event_details = pack.content.data.event_details[event_title]
    _, revised_event_details = pack.content.data.revised_post(event_title, event_details)
    event_date = dataset.anchor_date + timedelta(days=14)
    primary_board, imported_board = "control:duplicate", "control:import"
    post_key, event_key = "control:post", "control:event"
    group_rows: list[PhaseJsonValue] = [
        {"group_key": key, "level": "manage" if key == manager_group else level}
        for key, level in pack.content.data.project_groups
    ]
    dept_group, dept_level = pack.content.data.department_groups[department]
    group_rows.append(
        {
            "group_key": dept_group,
            "level": "manage" if dept_group == manager_group else dept_level,
        }
    )
    common = {"board_key": primary_board}
    actions: list[PhaseAction] = []

    def add(
        operation: str,
        suffix: str,
        actor: str,
        target: str,
        values: Mapping[str, PhaseJsonValue] | None = None,
        end: Mapping[str, PhaseJsonValue] | None = None,
        status: int = 200,
    ) -> None:
        actions.append(
            _action(
                operation,
                suffix,
                actor,
                target,
                values or {},
                end or {},
                expected_status=status,
            )
        )

    add(
        "board_duplicate",
        "duplicate",
        "admin",
        primary_board,
        {"source_board_key": source_board_key},
        {"scope": "project", "status": "active"},
        201,
    )
    add(
        "board_import",
        "import",
        "admin",
        imported_board,
        {"source_board_key": source_board_key},
        {"scope": "project", "status": "active"},
        201,
    )
    add(
        "board_share",
        "share-duplicate",
        "admin",
        primary_board,
        {"groups": group_rows},
        {"groups": group_rows},
    )
    add(
        "board_patch",
        "patch-duplicate",
        manager,
        primary_board,
        {"name": f"{board_name} follow-up"},
        {"name": f"{board_name} follow-up"},
    )

    add(
        "post_create",
        "create-post",
        manager,
        post_key,
        {
            **common,
            "title": post_title,
            "body": post_body,
            "links": [],
            "expires_at": None,
            "pinned": False,
        },
        {"status": "draft", "title": post_title},
        201,
    )
    add(
        "post_patch",
        "patch-post",
        manager,
        post_key,
        {**common, "title": updated_title, "body": updated_body},
        {"status": "draft", "title": updated_title},
    )
    add(
        "post_record_link_create",
        "link-post-record",
        manager,
        "control:post-link",
        {**common, "content_key": post_key, "record_key": record_key},
        {"linked": True},
        201,
    )
    add(
        "post_record_link_delete",
        "unlink-post-record",
        manager,
        "control:post-link",
        {**common, "content_key": post_key},
        {"linked": False},
        204,
    )
    for suffix, state in (("publish-post", "first"), ("republish-post", "second")):
        add(
            "post_publish",
            suffix,
            manager,
            post_key,
            {
                **common,
                "publication_key": str(
                    uuid5(
                        NAMESPACE_URL,
                        f"{pack.identity.uuid_namespace}:{dataset.seed}:board-control:{state}",
                    )
                ),
            },
            {"status": "published"},
        )
        if state == "first":
            add("post_unpublish", "unpublish-post", manager, post_key, common, {"status": "draft"})
    add("post_delete", "delete-post", manager, post_key, common, {"status": "archived"})
    add("post_restore", "restore-post", manager, post_key, common, {"status": "published"})

    add(
        "event_create",
        "create-event",
        manager,
        event_key,
        {
            **common,
            "title": event_title,
            "details": event_details,
            "location": pack.content.data.event_locations[0],
            "start_date": event_date.isoformat(),
            "end_date": event_date.isoformat(),
            "timezone_name": pack.identity.timezone,
            "recurrence": "none",
            "reminders": [],
            "links": [],
        },
        {"archived": False, "title": event_title},
        201,
    )
    add(
        "event_patch",
        "patch-event",
        manager,
        event_key,
        {**common, "details": revised_event_details},
        {"archived": False, "details": revised_event_details},
    )
    add(
        "event_record_link_create",
        "link-event-record",
        manager,
        "control:event-link",
        {**common, "content_key": event_key, "record_key": record_key},
        {"linked": True},
        201,
    )
    add(
        "event_record_link_delete",
        "unlink-event-record",
        manager,
        "control:event-link",
        {**common, "content_key": event_key},
        {"linked": False},
        204,
    )
    add("event_archive", "archive-event", manager, event_key, common, {"archived": True})
    add("event_restore", "restore-event", manager, event_key, common, {"archived": False})
    add(
        "event_archive",
        "archive-event-before-delete",
        manager,
        event_key,
        common,
        {"archived": True},
    )
    add("event_delete", "delete-event", manager, event_key, common, {"deleted": True}, 204)
    add(
        "widget_patch",
        "patch-widget",
        manager,
        "control:widget-source",
        {**common, "name": f"{board_name} progress"},
        {"updated": True},
    )
    add(
        "widget_duplicate",
        "duplicate-widget",
        manager,
        "control:widget-copy",
        {**common, "source_widget_key": "control:widget-source"},
        {"duplicate": True},
        201,
    )
    add("widget_order", "reorder-widgets", manager, primary_board, common, {"order_saved": True})
    add(
        "widget_delete",
        "delete-widget-copy",
        manager,
        "control:widget-copy",
        common,
        {"deleted": True},
        204,
    )
    add("purge_duplicate", "purge-duplicate", "admin", primary_board, {}, {"purged": True})
    add("purge_import", "purge-import", "admin", imported_board, {}, {"purged": True})
    return (*actions, *plan_board_file_controls(dataset))


def execute_board_control(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    operation = action.values.get("operation")
    if operation in FILE_OPERATIONS:
        return execute_board_file_action(action, context, on_substep=on_substep)
    if operation in {
        "post_record_link_create",
        "post_record_link_delete",
        "event_record_link_create",
        "event_record_link_delete",
    }:
        return execute_board_record_link_action(action, context, on_substep=on_substep)
    if operation in {"widget_patch", "widget_duplicate", "widget_order", "widget_delete"}:
        return execute_board_widget_action(action, context, on_substep=on_substep)
    if operation in {
        "board_duplicate",
        "board_import",
        "board_share",
        "board_patch",
        "purge_duplicate",
        "purge_import",
    }:
        return execute_board_action(action, context, on_substep=on_substep)
    return execute_board_content_action(action, dataset, context, on_substep=on_substep)


__all__ = [
    "CONTROL_ROUTES",
    "execute_board_control",
    "plan_board_controls",
    "verify_board_controls",
]
