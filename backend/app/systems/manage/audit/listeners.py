import logging
from collections.abc import Collection
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import event, inspect, select
from sqlalchemy.orm import Session, SessionTransaction

from app.core.database.session import AuditSession
from app.core.observability import log_event
from app.systems.boards.models import Board
from app.systems.manage.audit.context import get_audit_context
from app.systems.manage.audit.department_ancestry import DepartmentAncestry
from app.systems.manage.audit.models import AuditAction, AuditLog, SecurityEvent
from app.systems.manage.audit.snapshots import (
    AUDIT_METADATA_FIELDS,
    build_update_snapshot,
    serialize_record,
)
from app.systems.platform.events.models import event_for_entity
from app.systems.platform.events.publisher import publish_invalidations
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.relationships.models import RelationshipEdge

PENDING_CHANGES_KEY = "audit_pending_changes"
REALTIME_INVALIDATION_KEY = "realtime_invalidation_pending"
SAVEPOINT_INVALIDATION_KEY = "realtime_invalidation_savepoints"


@dataclass
class PendingChange:
    instance: Any
    action: AuditAction
    changes: dict[str, tuple[Any, Any]] | None = None
    department: UUID | Department | None = None
    board: UUID | Board | None = None


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


def _event_entity(instance: Any, entity: str) -> str:
    if entity in {"board_attachments", "board_record_links"}:
        if instance.card_id is not None:
            return "board_cards"
        return "board_posts" if instance.post_id is not None else "board_events"
    return {
        "organizations": "workspace_profiles",
        "board_groups": "boards",
        "board_card_labels": "board_cards",
        "board_card_checklist_items": "board_cards",
        "board_event_reminders": "board_events",
        "board_post_revisions": "board_posts",
        "board_post_revision_attachments": "board_posts",
        "board_post_revision_record_links": "board_posts",
    }.get(entity, entity)


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

    if pending and isinstance(session, Session):
        with session.no_autoflush:
            ancestry = DepartmentAncestry(session, (change.instance for change in pending))
            for change in pending:
                change.department = ancestry.for_instance(change.instance)
                change.board = ancestry.board_for_instance(change.instance)


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
        org_id = (change.instance.id if entity_type == "organizations"
                  else getattr(change.instance, "org_id", None))
        if entity_type in {"files", "in_app_notifications"}:
            proof = after if after is not None else before
            if proof is not None:
                proof["org_id"] = str(org_id) if org_id is not None else None
                discriminator = "purpose" if entity_type == "files" else "kind"
                proof[discriminator] = getattr(change.instance, discriminator)
        invalidation = event_for_entity(
            _event_entity(change.instance, entity_type),
            getattr(change.instance, "id", None),
            recipient_id=getattr(change.instance, "recipient_id", None),
            module_id=_event_module_id(change.instance, edge_modules),
            board_id=change.board.id if isinstance(change.board, Board) else change.board,
            org_id=org_id,
            account_id=(getattr(change.instance, "creator_id", None)
                        if entity_type == "files" and org_id is None else None),
        )
        if invalidation is not None:
            invalidations.append(invalidation)
        audit_log = AuditLog(
            org_id=org_id,
            action=change.action,
            entity_type=entity_type,
            entity_id=getattr(change.instance, "id", None),
            department_id=(
                change.department.id
                if isinstance(change.department, Department)
                else change.department
            ),
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


@event.listens_for(AuditSession, "after_transaction_create")
def remember_savepoint_invalidations(
    session: AuditSession, transaction: SessionTransaction
) -> None:
    if transaction.nested:
        # begin_nested flushes earlier work first, so this is the preceding items' buffer.
        snapshots = session.info.setdefault(SAVEPOINT_INVALIDATION_KEY, {})
        snapshots[transaction] = list(session.info.get(REALTIME_INVALIDATION_KEY, []))


@event.listens_for(AuditSession, "after_rollback")
def clear_pending_changes(session: AuditSession) -> None:
    session.info.pop(PENDING_CHANGES_KEY, None)
    if session.in_nested_transaction():
        snapshots = session.info.get(SAVEPOINT_INVALIDATION_KEY, {})
        previous = snapshots.pop(session.get_nested_transaction(), None)
        if previous is not None:
            if previous:
                session.info[REALTIME_INVALIDATION_KEY] = previous
            else:
                session.info.pop(REALTIME_INVALIDATION_KEY, None)
        return
    session.info.pop(SAVEPOINT_INVALIDATION_KEY, None)
    session.info.pop(REALTIME_INVALIDATION_KEY, None)


@event.listens_for(AuditSession, "after_commit")
def broadcast_committed_changes(session: AuditSession) -> None:
    """Best-effort cache invalidation after the audited transaction commits."""

    if session.in_nested_transaction():
        snapshots = session.info.get(SAVEPOINT_INVALIDATION_KEY, {})
        snapshots.pop(session.get_nested_transaction(), None)
        return
    session.info.pop(SAVEPOINT_INVALIDATION_KEY, None)
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
