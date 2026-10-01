"""School targets for the shared lifecycle and administration phase planner."""

from operations.sample_packs.phase_types import (
    DesignPhaseSpec,
    GroupAccessChangeSpec,
    GroupMoveSpec,
    PackPhaseData,
)

PHASES = PackPhaseData(
    group_move=GroupMoveSpec(
        source_group_key="finance-office",
        destination_group_key="guest-auditors",
    ),
    group_access_change=GroupAccessChangeSpec(
        group_key="admissions-team",
        department_key="admissions",
        module_key=None,
        current_level="write",
        replacement_level="read",
    ),
    openview_department_candidates=("hr", "academic", "finance"),
    existing_project_board=("Site Safety Review", "facilities"),
    purge_project_board_name="Site Safety Review Copy",
    purge_project_board_department="facilities",
    design=DesignPhaseSpec(
        module_key="fee_assessments",
        renamed_module_name="Fee Reconciliation Queue",
        text_field_name="Operational Review Notes",
        select_field_key="status",
        select_option_label="Reconciliation Review",
        new_module_key="phase_checklist",
        new_module_name="School Operations Checklist",
        new_module_department_key="facilities",
        new_module_title_field_name="Checklist Item",
    ),
)
