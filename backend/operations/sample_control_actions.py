"""Plan and execute the additional UI control journeys for any authored pack."""

import csv
import io
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any, cast

import httpx
from pydantic import ValidationError

from app.common.listing import PaginationMetadata
from operations.sample_blueprint import SampleDataset
from operations.sample_packs.phase_types import PhaseAction
from operations.sample_phase_actions import (
    PhaseExecutionContext,
    PhaseSubstep,
    SamplePhaseActionError,
    _id,
    _mapped_id,
    _request,
    _request_object,
    _result,
)


def _audit_actions(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    module = dataset.organization.catalog.modules[0]
    return tuple(
        PhaseAction(
            key=f"control:{operation}",
            phase="reorganization",
            kind="audit_controls",
            actor_key="admin",
            target_key=module.key,
            values={"operation": operation, "expected_label": module.name},
            expected_status=200,
            expected_detail=None,
            expected_end_state={
                "reviewed" if operation == "audit_review" else "exported": True,
                "target_label": module.name,
                "read_checks": 3 if operation == "audit_review" else 2,
            },
        )
        for operation in ("audit_review", "audit_export")
    )


def plan_controls(dataset: SampleDataset) -> tuple[PhaseAction, ...]:
    # Foundation-only offline packs have no lifecycle/content control anchors.
    if dataset.organization.phases is None:
        return ()
    from operations.sample_control_access import plan_access_controls
    from operations.sample_control_account import plan_account_controls
    from operations.sample_control_boards import plan_board_controls
    from operations.sample_control_manage import plan_manage_controls
    from operations.sample_control_openview import plan_openview_controls
    from operations.sample_control_platform import plan_platform_controls
    from operations.sample_control_read_reviews import plan_read_reviews
    from operations.sample_control_reads import plan_read_controls
    from operations.sample_control_sandbox import plan_sandbox_controls

    sandbox = plan_sandbox_controls(dataset)
    platform = plan_platform_controls(dataset)
    split = (
        next(
            i
            for i, row in enumerate(sandbox)
            if row.values["operation"] == "prepare_lifecycle_bindings"
        )
        + 1
    )

    return (
        *plan_account_controls(dataset),
        *plan_board_controls(dataset),
        *plan_openview_controls(dataset),
        *plan_access_controls(dataset),
        *sandbox[:split],
        *platform[:3],
        *sandbox[split:],
        *platform[3:],
        *_audit_actions(dataset),
        *plan_read_reviews(dataset),
        *plan_manage_controls(dataset),
        *plan_read_controls(dataset),
    )


def _audit_page(
    body: Mapping[str, Any], *, module_id: str, label: str, limit: int, step: str
) -> tuple[list[dict[str, Any]], int]:
    rows = body.get("items")
    try:
        pagination = PaginationMetadata.model_validate(body.get("pagination"))
    except ValidationError:
        raise SamplePhaseActionError("Audit pagination is invalid", step=step) from None
    if (
        not isinstance(rows, list)
        or not rows
        or any(not isinstance(row, dict) for row in rows)
        or pagination.limit != limit
        or pagination.offset != 0
        or pagination.count != len(rows)
        or pagination.count != min(limit, pagination.total)
        or pagination.has_more != (pagination.total > pagination.count)
    ):
        raise SamplePhaseActionError("Audit review has invalid entries or pagination", step=step)
    for row in rows:
        _id(row, "id", label="audit", step=step)
        if (
            row.get("entity_type") != "modules"
            or row.get("entity_id") != module_id
            or row.get("target_label") != label
        ):
            raise SamplePhaseActionError("Audit target identity or label differs", step=step)
    return cast(list[dict[str, Any]], rows), pagination.total


def _csv_cell(value: str) -> str:
    return "'" + value if re.match(r"^[\s\ufeff]*[=+\-@]", value) else value


def _audit_csv(
    response: httpx.Response, preview: list[dict[str, Any]], total: int, label: str
) -> int:
    step = "audit_export"
    if (
        response.headers.get("Content-Type", "").lower().replace(" ", "")
        != "text/csv;charset=utf-8"
        or response.headers.get("Content-Disposition")
        != 'attachment; filename="openslate-audit.csv"'
        or "no-store" not in response.headers.get("Cache-Control", "").lower().split(",")
    ):
        raise SamplePhaseActionError("Audit CSV download headers are invalid", step=step)
    try:
        count_header = response.headers.get("X-Audit-Export-Count", "")
        count = int(count_header)
        if str(count) != count_header:
            raise ValueError
        parsed = list(
            csv.reader(io.StringIO(response.content.decode("utf-8"), newline=""), strict=True)
        )
    except (ValueError, UnicodeError, csv.Error):
        raise SamplePhaseActionError("Audit CSV download is invalid", step=step) from None
    if (
        not parsed
        or parsed[0] != ["Date", "User", "Entity", "Action", "Target", "Before", "After"]
        or count != total
        or len(parsed) - 1 != total
        or any(
            len(row) != 7 or row[2] != "Modules" or row[4] != _csv_cell(label) for row in parsed[1:]
        )
    ):
        raise SamplePhaseActionError("Audit CSV columns, count or targets differ", step=step)
    try:
        if any(datetime.fromisoformat(row[0]).tzinfo is None for row in parsed[1:]):
            raise ValueError
    except ValueError:
        raise SamplePhaseActionError("Audit CSV contains an invalid date", step=step) from None
    for source, row in zip(preview, parsed[1:], strict=False):
        try:
            same_date = datetime.fromisoformat(row[0]) == datetime.fromisoformat(
                source["created_at"]
            )
        except (TypeError, ValueError):
            same_date = False
        if (
            not same_date
            or row[1] != _csv_cell(str(source.get("actor_name") or "").strip() or "Unknown person")
            or row[3] != str(source.get("action", "")).capitalize()
            or any(
                isinstance(snapshot := source.get(key), Mapping)
                and isinstance(name := snapshot.get("module_name"), str)
                and name not in row[column]
                for key, column in (("before", 5), ("after", 6))
            )
        ):
            raise SamplePhaseActionError("Audit CSV content differs from its preview", step=step)
    return count


def _execute_audit(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    on_substep: PhaseSubstep | None,
) -> dict[str, object]:
    if action not in _audit_actions(dataset):
        raise SamplePhaseActionError("Audit action differs from its authored plan", step=action.key)
    evidence: list[dict[str, object]] = []
    module_id = _mapped_id(context, "modules", action.target_key, step=action.key)
    label = str(action.values["expected_label"])
    exporting = action.values["operation"] == "audit_export"
    filters: dict[str, Any] = {
        "entity_type": "modules",
        "search": label,
        "sort_by": "created_at",
        "sort_order": "desc",
    }
    if exporting:
        filters["created_before"] = datetime.now(UTC).isoformat()
    limit = 10 if exporting else 25
    page = _request_object(
        action,
        context,
        evidence,
        actor_key=action.actor_key,
        path="/api/audit-logs",
        step="audit_preview" if exporting else "audit_list",
        on_substep=on_substep,
        params={**filters, "limit": limit, "offset": 0},
    )
    rows, total = _audit_page(
        page,
        module_id=module_id,
        label=label,
        limit=limit,
        step="audit_preview" if exporting else "audit_list",
    )
    extra: dict[str, object] = dict(action.expected_end_state)
    if exporting:
        if total > 10_000:
            raise SamplePhaseActionError(
                "Audit export exceeds its supported count", step="audit_preview"
            )
        response = _request(
            action,
            context,
            evidence,
            actor_key=action.actor_key,
            method="GET",
            path="/api/audit-logs/export",
            step="audit_export",
            expected=200,
            on_substep=on_substep,
            params=filters,
        )
        extra["row_count"] = _audit_csv(response, rows, total, label)
    else:
        audit_id = _id(rows[0], "id", label="audit", step="audit_list")
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
        if (
            detail.get("id") != audit_id
            or detail.get("entity_type") != "modules"
            or detail.get("entity_id") != module_id
            or detail.get("target_label") != label
        ):
            raise SamplePhaseActionError(
                "Audit detail identity or label differs", step="audit_detail"
            )
        extra["audit_id"] = audit_id
    return _result(action, context, evidence, [], extra=extra)


def execute_control_action(
    action: PhaseAction,
    dataset: SampleDataset,
    context: PhaseExecutionContext,
    *,
    on_substep: PhaseSubstep | None = None,
) -> dict[str, object]:
    if action.kind == "audit_controls":
        return _execute_audit(action, dataset, context, on_substep)
    from operations.sample_control_access import execute_access_control
    from operations.sample_control_account import execute_account_control
    from operations.sample_control_boards import execute_board_control
    from operations.sample_control_manage import execute_manage_control
    from operations.sample_control_openview import execute_openview_control
    from operations.sample_control_platform import execute_platform_control
    from operations.sample_control_read_reviews import execute_read_review
    from operations.sample_control_reads import execute_read_control
    from operations.sample_control_sandbox import execute_sandbox_control

    handlers = {
        "access_controls": execute_access_control,
        "account_controls": execute_account_control,
        "manage_controls": execute_manage_control,
        "platform_controls": execute_platform_control,
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
