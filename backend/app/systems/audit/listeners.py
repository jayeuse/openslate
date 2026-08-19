from dataclasses import dataclass
from typing import Any

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.systems.audit.context import get_audit_context
from app.systems.audit.models import AuditAction, AuditLog
from app.systems.audit.snapshots import (
    AUDIT_METADATA_FIELDS,
    build_update_snapshot,
    serialize_record,
)

PENDING_CHANGES_KEY = "audit_pending_changes"


@dataclass
class PendingChange:
    instance: Any
    action: AuditAction
    changes: dict[str, tuple[Any, Any]] | None = None


def _is_audited(instance: Any) -> bool:
    return bool(getattr(type(instance), "__audit_enabled__", True))


def _collect_changes(instance: Any) -> dict[str, tuple[Any, Any]]:
    state = inspect(instance)
    changes: dict[str, tuple[Any, Any]] = {}
    for attribute in state.mapper.column_attrs:
        field_name = attribute.key
        if field_name in AUDIT_METADATA_FIELDS:
            continue
        history = state.attrs[field_name].history
        if not history.has_changes():
            continue
        before = history.deleted[0] if history.deleted else None
        after = history.added[0] if history.added else getattr(instance, field_name)
        changes[field_name] = (before, after)
    return changes


def _set_performed_by(instance: Any, session: Session) -> None:
    if hasattr(instance, "performed_by"):
        instance.performed_by = get_audit_context(session).performed_by


@event.listens_for(AuditSession, "before_flush")
def capture_changes(session: AuditSession, flush_context: Any, instances: Any) -> None:
    pending = session.info.setdefault(PENDING_CHANGES_KEY, [])

    for instance in list(session.dirty) + list(session.deleted):
        if isinstance(instance, AuditLog):
            if instance in session.dirty or instance in session.deleted:
                raise RuntimeError("Audit logs are immutable")

    for instance in list(session.new):
        if isinstance(instance, AuditLog) and not getattr(instance, "_audit_internal", False):
            raise RuntimeError("Audit logs can only be created by the audit system")
        if _is_audited(instance):
            _set_performed_by(instance, session)
            pending.append(PendingChange(instance, AuditAction.CREATE))

    deleted_instances = set(session.deleted)
    for instance in list(session.dirty):
        if not _is_audited(instance) or instance in deleted_instances:
            continue
        changes = _collect_changes(instance)
        if not changes:
            continue
        _set_performed_by(instance, session)
        is_soft_delete = changes.get("is_deleted") == (False, True)
        pending.append(
            PendingChange(
                instance,
                AuditAction.DELETE if is_soft_delete else AuditAction.UPDATE,
                changes,
            )
        )

    for instance in list(session.deleted):
        if _is_audited(instance):
            pending.append(PendingChange(instance, AuditAction.DELETE))


@event.listens_for(AuditSession, "after_flush_postexec")
def create_audit_logs(session: AuditSession, flush_context: Any) -> None:
    pending = session.info.pop(PENDING_CHANGES_KEY, [])
    if not pending:
        return

    context = get_audit_context(session)
    for change in pending:
        if change.action is AuditAction.CREATE:
            snapshot = {"after": serialize_record(change.instance)}
        elif change.action is AuditAction.DELETE and change.changes is None:
            snapshot = {
                "before": serialize_record(
                    change.instance,
                    include_default_deletion_state=True,
                )
            }
        else:
            snapshot = build_update_snapshot(
                change.changes or {},
                getattr(type(change.instance), "__audit_redacted_fields__", frozenset()),
            )

        table_name = inspect(change.instance).mapper.local_table.name
        audit_log = AuditLog(
            action=change.action,
            table_name=table_name,
            record_id=change.instance.id,
            snapshot=snapshot,
            request_id=context.request_id,
            request_method=context.request_method,
            request_path=context.request_path,
            performed_by=context.performed_by,
        )
        object.__setattr__(audit_log, "_audit_internal", True)
        session.add(audit_log)


@event.listens_for(AuditSession, "after_rollback")
def clear_pending_changes(session: AuditSession) -> None:
    session.info.pop(PENDING_CHANGES_KEY, None)


@event.listens_for(AuditSession, "do_orm_execute")
def reject_bulk_mutations(execute_state: Any) -> None:
    if not execute_state.is_select:
        raise RuntimeError(
            "Bulk or raw ORM mutations are not supported; mutate audited models individually"
        )
