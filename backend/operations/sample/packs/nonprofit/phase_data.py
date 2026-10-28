"""Foundation targets for the shared lifecycle and administration phase planner."""

from operations.sample.packs.phase_types import (
    DesignPhaseSpec,
    GroupAccessChangeSpec,
    GroupMoveSpec,
    PackPhaseData,
)

PHASES = PackPhaseData(
    # A finance staff member joins the audit liaison group: Finance and Procurement reads only.
    group_move=GroupMoveSpec(source_group_key="finance-team", destination_group_key="audit-guests"),
    group_access_change=GroupAccessChangeSpec(
        group_key="rm-team",
        department_key="resource_mobilization",
        module_key=None,
        current_level="write",
        replacement_level="read",
    ),
    openview_department_candidates=("meal", "procurement", "grants_partnerships"),
    existing_project_board=("Annual Audit Preparation", "finance"),
    purge_project_board_name="Annual Audit Preparation Copy",
    purge_project_board_department="finance",
    design=DesignPhaseSpec(
        module_key="grant_reports",
        renamed_module_name="Donor Report Tracker",
        text_field_name="Reviewer Comments",
        select_field_key="status",
        select_option_label="Funder Query",
        new_module_key="phase_checklist",
        new_module_name="Compliance Checklist",
        new_module_department_key="executive_office",
        new_module_title_field_name="Checklist Item",
    ),
)
