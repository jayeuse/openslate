"""Purge inventory for files and saved views, without external storage I/O."""

import hashlib
import json
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.files.models import File
from app.systems.lifecycle.planning_scope import LifecycleScope, row_state
from app.systems.lifecycle.schemas import (
    LifecycleBlocker,
    LifecycleBlockerCode,
    LifecycleRowState,
    LifecycleTargetType,
)
from app.systems.views.models import SavedView


@dataclass(frozen=True)
class PurgeDependencies:
    rows: tuple[LifecycleRowState, ...]
    blockers: tuple[LifecycleBlocker, ...]
    ids: dict[str, tuple[UUID, ...]]


def fingerprint(values: object) -> str:
    encoded = json.dumps(values, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode()).hexdigest()


def load_purge_dependencies(
    db: Session, scope: LifecycleScope, target: LifecycleTargetType
) -> PurgeDependencies:
    record_ids = [record.id for record in scope.records]
    module_ids = (
        [module.id for module in scope.modules]
        if target in {LifecycleTargetType.DEPARTMENT, LifecycleTargetType.MODULE}
        else []
    )
    files = (
        list(db.scalars(select(File).where(File.record_id.in_(record_ids)).order_by(File.id)))
        if record_ids
        else []
    )
    views = (
        list(
            db.scalars(
                select(SavedView).where(SavedView.module_id.in_(module_ids)).order_by(SavedView.id)
            )
        )
        if module_ids
        else []
    )
    rows: list[LifecycleRowState] = []
    blockers: list[LifecycleBlocker] = []
    for file in files:
        state = row_state("files", file)
        state.byte_count = file.actual_size or file.expected_size
        state.state_fingerprint = fingerprint(
            {
                key: getattr(file, key)
                for key in (
                    "state",
                    "purpose",
                    "record_id",
                    "actual_size",
                    "expected_size",
                    "digest",
                    "operation_id",
                    "operation_expires_at",
                    "object_key",
                )
            }
        )
        rows.append(state)
        if file.state != "purged":
            blockers.append(
                LifecycleBlocker(
                    code=LifecycleBlockerCode.PURGE_FILE_DEPENDENCY,
                    entity_type="files",
                    entity_id=file.id,
                    detail=(
                        "Purge the attached file and confirm object deletion "
                        "before purging its parent"
                    ),
                    conflicting_entity_type="records",
                    conflicting_entity_id=file.record_id,
                )
            )
    for view in views:
        state = row_state("saved_views", view)
        state.state_fingerprint = fingerprint(
            {
                key: getattr(view, key)
                for key in ("module_id", "owner_id", "revision", "visibility", "name", "definition")
            }
        )
        rows.append(state)
    return PurgeDependencies(
        tuple(rows),
        tuple(blockers),
        {
            "files": tuple(file.id for file in files),
            "saved_views": tuple(view.id for view in views),
        },
    )
