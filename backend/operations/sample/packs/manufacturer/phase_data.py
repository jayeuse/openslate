"""Sauce plant targets for the shared lifecycle and administration phase planner."""

from operations.sample.packs.phase_types import (
    DesignPhaseSpec,
    GroupAccessChangeSpec,
    GroupMoveSpec,
    PackPhaseData,
)

PHASES = PackPhaseData(
    # A receivables clerk moves to collections: payments only, no new access.
    group_move=GroupMoveSpec(source_group_key="finance-ar",
                             destination_group_key="finance-collections"),  # fmt: skip
    group_access_change=GroupAccessChangeSpec(
        group_key="maintenance-team",
        department_key="maintenance",
        module_key=None,
        current_level="write",
        replacement_level="read",
    ),
    openview_department_candidates=("quality", "maintenance", "finance"),
    existing_project_board=("GFSI Certification Audit", "quality"),
    purge_project_board_name="GFSI Certification Audit Copy",
    purge_project_board_department="quality",
    design=DesignPhaseSpec(
        module_key="downtime_events",
        renamed_module_name="Line Stoppage Log",
        text_field_name="Root Cause Notes",
        select_field_key="status",
        select_option_label="Escalated to Maintenance",
        new_module_key="phase_checklist",
        new_module_name="Plant Operations Checklist",
        new_module_department_key="manufacturing",
        new_module_title_field_name="Checklist Item",
    ),
)
