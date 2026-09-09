from datetime import UTC, datetime

from uuid6 import uuid7

from app.systems.lifecycle.planner import canonical_lifecycle_digest
from app.systems.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleEdgeState,
    LifecycleKeyStrip,
    LifecycleOperation,
    LifecycleRowState,
    LifecycleTargetType,
)


def test_digest_is_order_independent_and_binds_operation_actor_and_destructive_impacts() -> None:
    actor, root, field_id, source_id, target_id = [uuid7() for _ in range(5)]
    state = {"is_deleted": True, "deleted_at": None, "updated_at": datetime(2026, 1, 1, tzinfo=UTC)}
    rows = [
        LifecycleRowState(entity_type="fields", entity_id=field_id, **state),
        LifecycleRowState(entity_type="modules", entity_id=root, **state),
    ]
    arguments = (LifecycleOperation.PURGE, LifecycleTargetType.FIELD, root, actor)
    base = canonical_lifecycle_digest(*arguments, rows)
    assert base == canonical_lifecycle_digest(*arguments, list(reversed(rows)))
    assert base != canonical_lifecycle_digest(
        LifecycleOperation.CLOSE,
        *arguments[1:],
        rows,
    )
    assert base != canonical_lifecycle_digest(*arguments[:3], uuid7(), rows)

    edge = LifecycleEdgeState(
        edge_id=uuid7(),
        field_id=field_id,
        source_record_id=source_id,
        target_record_id=target_id,
        available=True,
        **state,
    )
    impacts = {
        "edges": [edge],
        "key_strips": [
            LifecycleKeyStrip(
                record_id=source_id,
                module_id=root,
                field_id=field_id,
                key=str(field_id),
            )
        ],
        "blockers": [
            LifecycleBlocker(
                code=LifecycleBlockerCode.PURGE_EXTERNAL_SCHEMA_DEPENDENCY,
                entity_type="fields",
                entity_id=field_id,
                detail="external relationship",
            )
        ],
    }
    for name, values in impacts.items():
        assert base != canonical_lifecycle_digest(*arguments, rows, **{name: values})
    assert canonical_lifecycle_digest(*arguments, rows, edges=[edge]) != canonical_lifecycle_digest(
        *arguments,
        rows,
        edges=[edge.model_copy(update={"is_deleted": False})],
    )
