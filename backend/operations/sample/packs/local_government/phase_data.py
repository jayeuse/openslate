"""City government targets for the shared lifecycle and administration phase planner."""

from operations.sample.packs.phase_types import (
    DesignPhaseSpec,
    GroupAccessChangeSpec,
    GroupMoveSpec,
    PackPhaseData,
)

PHASES = PackPhaseData(
    # A council secretariat clerk moves to the records unit: communications only, no new access.
    group_move=GroupMoveSpec(source_group_key="clerk-staff", destination_group_key="records-unit"),
    group_access_change=GroupAccessChangeSpec(
        group_key="bplo-staff",
        department_key="bplo",
        module_key=None,
        current_level="write",
        replacement_level="read",
    ),
    openview_department_candidates=("city_clerk", "procurement", "budget_accounting"),
    existing_project_board=("Annual Budget Preparation", "budget_accounting"),
    purge_project_board_name="Annual Budget Preparation Copy",
    purge_project_board_department="budget_accounting",
    design=DesignPhaseSpec(
        module_key="communications",
        renamed_module_name="Document Tracking Log",
        text_field_name="Routing Notes",
        select_field_key="status",
        select_option_label="For Mayor's Signature",
        new_module_key="phase_checklist",
        new_module_name="City Hall Operations Checklist",
        new_module_department_key="city_clerk",
        new_module_title_field_name="Checklist Item",
    ),
)
