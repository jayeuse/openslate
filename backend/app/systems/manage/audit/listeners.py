import logging
from collections.abc import Collection
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import event, inspect, select
from sqlalchemy.orm import Session

from app.core.database.session import AuditSession
from app.core.observability import log_event
from app.systems.manage.audit.context import get_audit_context
from app.systems.manage.audit.models import AuditAction, AuditLog, SecurityEvent
from app.systems.manage.audit.snapshots import (
    AUDIT_METADATA_FIELDS,
    build_update_snapshot,
    serialize_record,
)
from app.systems.platform.events.models import event_for_entity
from app.systems.platform.events.publisher import publish_invalidations
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge

PENDING_CHANGES_KEY = "audit_pending_changes"
REALTIME_INVALIDATION_KEY = "realtime_invalidation_pending"


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


def _record_redacted_fields(
    session: Session,
    pending: list[PendingChange],
) -> dict[UUID, frozenset[str]]:
    module_ids = {
        change.instance.module_id for change in pending if isinstance(change.instance, Record)
    }
    if not module_ids:
        return {}

    redacted_fields = session.scalars(
        select(Field).where(
            Field.module_id.in_(module_ids),
            Field.audit_redacted.is_(True),
        )
    ).all()
    fields_by_module: dict[UUID, set[str]] = {}
    for field in redacted_fields:
        fields_by_module.setdefault(field.module_id, set()).add(str(field.id))
    return {module_id: frozenset(field_ids) for module_id, field_ids in fields_by_module.items()}


def _edge_modules(session: Session, pending: list[PendingChange]) -> dict[UUID, UUID]:
    """Map relationship fields to the module that owns them, for event routing."""

    field_ids = {
        change.instance.field_id
        for change in pending
        if isinstance(change.instance, RelationshipEdge)
    }
    if not field_ids:
        return {}
    return {
        field_id: module_id
        for field_id, module_id in session.execute(
            select(Field.id, Field.module_id).where(Field.id.in_(field_ids))
        ).tuples()
    }


def _event_module_id(instance: Any, edge_modules: dict[UUID, UUID]) -> UUID | None:
    if isinstance(instance, Module):
        return instance.id
    if isinstance(instance, RelationshipEdge):
        return edge_modules.get(instance.field_id)
    module_id = getattr(instance, "module_id", None)
    return module_id if isinstance(module_id, UUID) else None


@event.listens_for(AuditSession, "before_flush")
def capture_changes(session: AuditSession, flush_context: Any, instances: Any) -> None:
    pending = session.info.setdefault(PENDING_CHANGES_KEY, [])

    for instance in list(session.new) + list(session.dirty) + list(session.deleted):
        if isinstance(instance, SecurityEvent):
            if instance in session.new and getattr(instance, "_security_event_internal", False):
                continue
            raise RuntimeError("Security events can only be appended by the security event writer")

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
    record_redacted_fields = _record_redacted_fields(session, pending)
    edge_modules = _edge_modules(session, pending)
    invalidations = session.info.setdefault(REALTIME_INVALIDATION_KEY, [])
    for change in pending:
        dynamic_redacted_fields = (
            record_redacted_fields.get(change.instance.module_id, frozenset())
            if isinstance(change.instance, Record)
            else frozenset()
        )
        before: dict[str, Any] | None = None
        after: dict[str, Any] | None = None
        if change.action is AuditAction.CREATE:
            after = serialize_record(
                change.instance,
                redacted_fields=dynamic_redacted_fields,
            )
        elif change.action is AuditAction.DELETE and change.changes is None:
            before = serialize_record(
                change.instance,
                include_default_deletion_state=True,
                redacted_fields=dynamic_redacted_fields,
            )
        else:
            model_redacted_fields: Collection[str] = getattr(
                type(change.instance),
                "__audit_redacted_fields__",
                frozenset(),
            )
            snapshot = build_update_snapshot(
                change.changes or {},
                frozenset((*model_redacted_fields, *dynamic_redacted_fields)),
            )
            before = snapshot["before"]
            after = snapshot["after"]

        entity_type = inspect(change.instance).mapper.local_table.name
        invalidation = event_for_entity(
            entity_type,
            getattr(change.instance, "id", None),
            recipient_id=getattr(change.instance, "recipient_id", None),
            module_id=_event_module_id(change.instance, edge_modules),
        )
        if invalidation is not None:
            invalidations.append(invalidation)
        audit_log = AuditLog(
            action=change.action,
            entity_type=entity_type,
            entity_id=getattr(change.instance, "id", None),
            before=before,
            after=after,
            request_id=context.request_id,
            request_method=context.request_method,
            request_path=context.request_path,
            performed_by=context.performed_by,
            actor_label=context.actor_label,
        )
        object.__setattr__(audit_log, "_audit_internal", True)
        session.add(audit_log)


@event.listens_for(AuditSession, "after_rollback")
def clear_pending_changes(session: AuditSession) -> None:
    session.info.pop(PENDING_CHANGES_KEY, None)
    session.info.pop(REALTIME_INVALIDATION_KEY, None)


@event.listens_for(AuditSession, "after_commit")
def broadcast_committed_changes(session: AuditSession) -> None:
    """Best-effort cache invalidation after the audited transaction commits."""

    invalidations = session.info.pop(REALTIME_INVALIDATION_KEY, [])
    if not invalidations:
        return
    try:
        publish_invalidations(tuple(dict.fromkeys(invalidations)))
    except Exception:
        # Realtime is best-effort: a committed mutation remains successful.
        log_event(
            "realtime_invalidation_failure",
            level=logging.WARNING,
            reason_code="broadcast_failed",
            upstream="postgresql",
        )


@event.listens_for(AuditSession, "do_orm_execute")
def reject_bulk_mutations(execute_state: Any) -> None:
    if not execute_state.is_select:
        raise RuntimeError(
            "Bulk or raw ORM mutations are not supported; mutate audited models individually"
        )
