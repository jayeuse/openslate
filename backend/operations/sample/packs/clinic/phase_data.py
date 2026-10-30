"""Clinic targets for the shared lifecycle and administration phase planner."""

from operations.sample.packs.phase_types import (
    DesignPhaseSpec,
    GroupAccessChangeSpec,
    GroupMoveSpec,
    PackPhaseData,
)

PHASES = PackPhaseData(
    # A storekeeper moves to the contractor group: equipment reads only, no new access.
    group_move=GroupMoveSpec(
        source_group_key="operations-supply",
        destination_group_key="biomed-contractors",
    ),
    group_access_change=GroupAccessChangeSpec(
        group_key="front-desk",
        department_key="patient_access",
        module_key=None,
        current_level="write",
        replacement_level="read",
    ),
    openview_department_candidates=("quality", "operations", "revenue_cycle"),
    existing_project_board=("Accreditation Readiness", "quality"),
    purge_project_board_name="Accreditation Readiness Copy",
    purge_project_board_department="quality",
    design=DesignPhaseSpec(
        module_key="claims",
        renamed_module_name="Claim Follow-up Queue",
        text_field_name="Billing Review Notes",
        select_field_key="status",
        select_option_label="Coding Review",
        new_module_key="phase_checklist",
        new_module_name="Clinic Operations Checklist",
        new_module_department_key="operations",
        new_module_title_field_name="Checklist Item",
    ),
)
