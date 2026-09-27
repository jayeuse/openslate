"""Retained Board widget dependencies for physical source purges."""

from collections.abc import Callable
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.boards.models import BoardWidget
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.lifecycle.planning_scope import row_state
from app.systems.sandbox.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
)


def _references_field(config: dict[str, object], field_ids: set[str]) -> bool:
    references: list[object] = []
    for key in ("fields", "filters"):
        entries = config.get(key)
        if isinstance(entries, list):
            references.extend(entries)
    references.append(config.get("metric"))
    return any(
        isinstance(reference, dict)
        and isinstance(reference.get("field_id"), str)
        and reference["field_id"] in field_ids
        for reference in references
    )


def load_board_widget_purge_dependencies(
    db: Session,
    module_ids: list[UUID],
    target_field: Field | None,
    fingerprint: Callable[[object], str],
) -> tuple[list[LifecycleRowState], list[LifecycleBlocker], dict[str, tuple[UUID, ...]]]:
    """Inspect all retained widgets for scoped modules, including deleted rows."""

    widgets = (
        list(
            db.scalars(
                select(BoardWidget)
                .where(BoardWidget.module_id.in_(module_ids))
                .order_by(BoardWidget.id)
            )
        )
        if module_ids
        else []
    )
    if target_field is not None:
        field_ids = {str(target_field.id)}
        widgets = [widget for widget in widgets if _references_field(widget.config, field_ids)]

    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    for widget in widgets:
        state = row_state("board_widgets", widget)
        state.state_fingerprint = fingerprint(
            {
                key: getattr(widget, key)
                for key in (
                    "board_id",
                    "module_id",
                    "creator_id",
                    "name",
                    "position",
                    "widget_type",
                    "config",
                    "audience_kind",
                    "audience_user_id",
                )
            }
        )
        rows.append(state)
        blockers.append(
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_BOARD_DEPENDENCY,
                entity_type="board_widgets",
                entity_id=widget.id,
                detail=(
                    "Permanently delete this Board widget or its Board, or update its field "
                    "references, before purging the source Field"
                    if target_field is not None
                    else "Permanently delete this Board widget or its Board before purging "
                    "the source Module"
                ),
                conflicting_entity_type="boards",
                conflicting_entity_id=widget.board_id,
                field_id=target_field.id if target_field is not None else None,
                field_name=target_field.name if target_field is not None else None,
                module_id=widget.module_id,
            )
        )
    return (
        rows,
        blockers,
        {
            "board_widgets": tuple(widget.id for widget in widgets),
            "boards": tuple(sorted({widget.board_id for widget in widgets})),
        },
    )
