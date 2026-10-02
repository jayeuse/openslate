"""Plan and execute the additional UI control journeys for any authored pack."""

from operations.sample_blueprint import SampleDataset
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_phase_actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _read_json,
    _request,
    _request_object,
    _result,
)


def plan_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    # Foundation-only offline packs have no lifecycle/content control anchors.
    if dataset.organization.phases is None:
        return ()
    from operations.sample_control_access import plan_access_controls
    from operations.sample_control_account import plan_account_controls
    from operations.sample_control_boards import plan_board_controls
    from operations.sample_control_openview import plan_openview_controls
    from operations.sample_control_read_reviews import plan_read_reviews
    from operations.sample_control_reads import plan_read_controls
    from operations.sample_control_sandbox import plan_sandbox_controls

    audit = PhaseAction(
        key="control:audit_review",
        phase="reorganization",
        kind="audit_controls",
        actor_key="admin",
        target_key="control:audit",
        values={"operation": "audit_review"},
        expected_status=200,
        expected_detail=None,
        expected_end_state={"reviewed": True},
    )
    return (
        *plan_account_controls(dataset),
        *plan_board_controls(dataset),
        *plan_openview_controls(dataset),
        *plan_access_controls(dataset),
        *plan_sandbox_controls(dataset),
        audit,
        *plan_read_reviews(dataset),
        *plan_read_controls(dataset),
    )


def execute_control_action(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action.kind == "audit_controls":
        evidence: list[dict[str, object]] = []
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="GET",
            path="/api/audit-logs",
            step="audit_list",
            expected=200,
            on_substep=on_substep,
            params={"limit": 25, "offset": 0, "sort_by": "created_at", "sort_order": "desc"},
        )
        page = _read_json(response, step="audit_list")
        rows = page.get("items")
        if not isinstance(rows, list) or not rows or not isinstance(rows[0], dict):
            raise SamplePhaseActionError("Audit review has no entries", step="audit_list")
        audit_id = _id({"entry": rows[0].get("id")}, "entry", label="audit", step="audit_list")
        options = _request_object(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            path="/api/audit-logs/options",
            step="audit_options",
            on_substep=on_substep,
        )
        if not isinstance(options.get("entity_types"), list) or not isinstance(
            options.get("actors"), list
        ):
            raise SamplePhaseActionError("Audit options are invalid", step="audit_options")
        detail = _request_object(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            path=f"/api/audit-logs/{audit_id}",
            step="audit_detail",
            on_substep=on_substep,
        )
        if detail.get("id") != audit_id:
            raise SamplePhaseActionError(
                "Audit detail differs from the selected entry", step="audit_detail"
            )
        return _result(
            action, context, evidence, [], extra={"audit_id": audit_id, "read_checks": 3}
        )
    from operations.sample_control_access import execute_access_control
    from operations.sample_control_account import execute_account_control
    from operations.sample_control_boards import execute_board_control
    from operations.sample_control_openview import execute_openview_control
    from operations.sample_control_read_reviews import execute_read_review
    from operations.sample_control_reads import execute_read_control
    from operations.sample_control_sandbox import execute_sandbox_control

    handlers = {
        "access_controls": execute_access_control,
        "account_controls": execute_account_control,
        "board_controls": execute_board_control,
        "openview_controls": execute_openview_control,
        "sandbox_controls": execute_sandbox_control,
        "read_controls": (
            execute_read_control
            if action.values.get("operation") == "revoke_user_sessions"
            else execute_read_review
        ),
    }
    handler = handlers.get(action.kind)
    if handler is None:
        raise SamplePhaseActionError("Unsupported planned control journey", step=action.key)
    return handler(action, dataset, context, on_substep=on_substep)
