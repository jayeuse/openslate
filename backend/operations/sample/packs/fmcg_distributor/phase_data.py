"""Distributor targets for the shared lifecycle and administration phase planner."""

from operations.sample.packs.phase_types import (
    DesignPhaseSpec,
    GroupAccessChangeSpec,
    GroupMoveSpec,
    PackPhaseData,
)

PHASES = PackPhaseData(
    # A salesperson moves to the principal representatives' group: scheme and SKU reads
    # only, which the sales team already has, so no access grows.
    group_move=GroupMoveSpec(
        source_group_key="sales-team",
        destination_group_key="principal-reps",
    ),
    group_access_change=GroupAccessChangeSpec(
        group_key="logistics-team",
        department_key="logistics",
        module_key=None,
        current_level="write",
        replacement_level="read",
    ),
    openview_department_candidates=("credit_collections", "accounting", "warehouse",
                                    "purchasing"),  # fmt: skip
    existing_project_board=("Principal Claims Recovery", "accounting"),
    purge_project_board_name="Principal Claims Recovery Copy",
    purge_project_board_department="accounting",
    design=DesignPhaseSpec(
        module_key="principal_claims",
        renamed_module_name="Principal Claim Follow-up",
        text_field_name="Claim Review Notes",
        select_field_key="status",
        select_option_label="Awaiting principal proof",
        new_module_key="phase_checklist",
        new_module_name="Distributor Operations Checklist",
        new_module_department_key="warehouse",
        new_module_title_field_name="Checklist Item",
    ),
)
