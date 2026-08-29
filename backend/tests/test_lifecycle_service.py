from datetime import UTC, datetime
from uuid import UUID, uuid7

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


def test_lifecycle_contract_has_explicit_targets_and_operations() -> None:
    assert [item.value for item in LifecycleTargetType] == [
        "department",
        "module",
        "field",
        "record",
    ]
    assert [item.value for item in LifecycleOperation] == [
        "close",
        "reopen",
        "purge",
    ]


def test_lifecycle_digest_is_canonical_and_order_independent() -> None:
    actor_id = uuid7()
    first = [
        LifecycleRowState(
            entity_type="modules",
            entity_id=uuid7(),
            is_deleted=False,
            deleted_at=None,
            updated_at=datetime(2026, 1, 1, tzinfo=UTC),
        ),
        LifecycleRowState(
            entity_type="departments",
            entity_id=uuid7(),
            is_deleted=False,
            deleted_at=None,
            updated_at=datetime(2026, 1, 1, tzinfo=UTC),
        ),
    ]
    second = list(reversed(first))

    assert canonical_lifecycle_digest(
        LifecycleOperation.CLOSE,
        LifecycleTargetType.DEPARTMENT,
        first[1].entity_id,
        actor_id,
        first,
    ) == canonical_lifecycle_digest(
        LifecycleOperation.CLOSE,
        LifecycleTargetType.DEPARTMENT,
        first[1].entity_id,
        actor_id,
        second,
    )
    assert canonical_lifecycle_digest(
        LifecycleOperation.REOPEN,
        LifecycleTargetType.DEPARTMENT,
        first[1].entity_id,
        actor_id,
        first,
    ) != canonical_lifecycle_digest(
        LifecycleOperation.CLOSE,
        LifecycleTargetType.DEPARTMENT,
        first[1].entity_id,
        actor_id,
        first,
    )


def test_purge_digest_changes_for_each_destructive_impact() -> None:
    actor_id = UUID("00000000-0000-0000-0000-000000000001")
    root_id = UUID("00000000-0000-0000-0000-000000000002")
    row = LifecycleRowState(
        entity_type="fields",
        entity_id=UUID("00000000-0000-0000-0000-000000000003"),
        is_deleted=True,
        deleted_at=datetime(2026, 1, 1, tzinfo=UTC),
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
    )
    edge = LifecycleEdgeState(
        edge_id=UUID("00000000-0000-0000-0000-000000000004"),
        field_id=row.entity_id,
        source_record_id=UUID("00000000-0000-0000-0000-000000000005"),
        target_record_id=UUID("00000000-0000-0000-0000-000000000006"),
        is_deleted=False,
        deleted_at=None,
        updated_at=datetime(2026, 1, 1, tzinfo=UTC),
        available=True,
    )
    strip = LifecycleKeyStrip(
        record_id=edge.source_record_id,
        module_id=UUID("00000000-0000-0000-0000-000000000007"),
        field_id=row.entity_id,
        key=str(row.entity_id),
    )
    blocker = LifecycleBlocker(
        code=LifecycleBlockerCode.PURGE_EXTERNAL_SCHEMA_DEPENDENCY,
        entity_type="fields",
        entity_id=UUID("00000000-0000-0000-0000-000000000008"),
        detail="external relationship",
    )

    base = canonical_lifecycle_digest(
        LifecycleOperation.PURGE,
        LifecycleTargetType.FIELD,
        root_id,
        actor_id,
        [row],
    )
    assert base != canonical_lifecycle_digest(
        LifecycleOperation.PURGE,
        LifecycleTargetType.FIELD,
        root_id,
        actor_id,
        [row],
        edges=[edge],
    )
    assert base != canonical_lifecycle_digest(
        LifecycleOperation.PURGE,
        LifecycleTargetType.FIELD,
        root_id,
        actor_id,
        [row],
        key_strips=[strip],
    )
    assert base != canonical_lifecycle_digest(
        LifecycleOperation.PURGE,
        LifecycleTargetType.FIELD,
        root_id,
        actor_id,
        [row],
        blockers=[blocker],
    )
    changed_edge = edge.model_copy(update={"is_deleted": True})
    assert canonical_lifecycle_digest(
        LifecycleOperation.PURGE,
        LifecycleTargetType.FIELD,
        root_id,
        actor_id,
        [row],
        edges=[edge],
    ) != canonical_lifecycle_digest(
        LifecycleOperation.PURGE,
        LifecycleTargetType.FIELD,
        root_id,
        actor_id,
        [row],
        edges=[changed_edge],
    )
