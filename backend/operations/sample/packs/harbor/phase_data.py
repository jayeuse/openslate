"""Harbor targets for the shared lifecycle and administration phase planner."""

from operations.sample.packs.phase_types import (
    DesignPhaseSpec,
    GroupAccessChangeSpec,
    GroupMoveSpec,
    PackPhaseData,
)

PHASES = PackPhaseData(
    group_move=GroupMoveSpec(
        source_group_key="harbor-operations",
        destination_group_key="internal-audit",
    ),
    group_access_change=GroupAccessChangeSpec(
        group_key="purchasing-review",
        department_key="purchasing",
        module_key=None,
        current_level="write",
        replacement_level="read",
    ),
    openview_department_candidates=("finance", "service", "sales"),
    existing_project_board=("Fleet Reliability", "field"),
    purge_project_board_name="Fleet Reliability Copy",
    purge_project_board_department="field",
    design=DesignPhaseSpec(
        module_key="invoices",
        renamed_module_name="Invoice Reconciliation Queue",
        text_field_name="Operational Review Notes",
        select_field_key="status",
        select_option_label="Reconciliation Review",
        new_module_key="phase_checklist",
        new_module_name="Reconciliation Checklist",
        new_module_department_key="finance",
        new_module_title_field_name="Checklist Item",
    ),
)
