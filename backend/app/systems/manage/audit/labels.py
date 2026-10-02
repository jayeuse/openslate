"""Audit labels from permitted history or batched, currently authorized targets."""

from collections import defaultdict
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.checks import department_filter, module_filter
from app.systems.access.policy.models import AccessLevel
from app.systems.access.users.models import User
from app.systems.manage.audit.models import AuditLog
from app.systems.manage.audit.snapshots import REDACTED
from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.display import UNAVAILABLE_OPTION, FieldDisplayResolver
from app.systems.sandbox.records.models import Record


def humanize_entity_type(value: str) -> str:
    return " ".join(word[0].upper() + word[1:] for word in value.split("_") if word)


def _snapshot_label(log: AuditLog) -> str | None:
    for snapshot in (log.after, log.before):
        for key in ("name", "title"):
            value = (snapshot or {}).get(key)
            if isinstance(value, str) and (label := value.strip()) and label != REDACTED:
                return label
    return None


def target_labels(db: Session, user: User, logs: list[AuditLog]) -> dict[UUID, str]:
    labels: dict[UUID, str] = {}
    missing: dict[str, set[UUID]] = defaultdict(set)
    for log in logs:
        snapshot = _snapshot_label(log)
        labels[log.id] = (
            snapshot or f"{humanize_entity_type(log.entity_type) or 'Target'} · name unavailable"
        )
        if snapshot is None and log.entity_id is not None:
            missing[log.entity_type].add(log.entity_id)

    current: dict[tuple[str, UUID], str] = {}
    if ids := missing.get("departments"):
        for target_id, name in db.execute(
            select(Department.id, Department.department_name).where(
                Department.id.in_(ids),
                Department.is_deleted.is_(False),
                Department.deleted_at.is_(None),
                department_filter(db, user, Department.id),
            )
        ):
            current[("departments", target_id)] = name
    if ids := missing.get("modules"):
        for target_id, name in db.execute(
            select(Module.id, Module.module_name).where(
                Module.id.in_(ids),
                Module.is_deleted.is_(False),
                Module.deleted_at.is_(None),
                module_filter(db, user, AccessLevel.READ, Module.id),
            )
        ):
            current[("modules", target_id)] = name
    if ids := missing.get("fields"):
        for target_id, name in db.execute(
            select(Field.id, Field.name)
            .join(Module, Module.id == Field.module_id)
            .where(
                Field.id.in_(ids),
                Field.is_deleted.is_(False),
                Field.deleted_at.is_(None),
                Module.is_deleted.is_(False),
                Module.deleted_at.is_(None),
                module_filter(db, user, AccessLevel.READ, Module.id),
            )
        ):
            current[("fields", target_id)] = name
    if ids := missing.get("records"):
        # Resolve the CURRENT module, never the audit row's historical department.
        records = db.execute(
            select(Record.id, Record.data, Field)
            .join(Module, Module.id == Record.module_id)
            .join(Field, Field.id == Module.title_field_id)
            .where(
                Record.id.in_(ids),
                Record.is_deleted.is_(False),
                Record.deleted_at.is_(None),
                Module.is_deleted.is_(False),
                Module.deleted_at.is_(None),
                Field.module_id == Module.id,
                Field.is_deleted.is_(False),
                Field.deleted_at.is_(None),
                Field.audit_redacted.is_(False),
                Field.type.in_(
                    (
                        FieldType.TEXT,
                        FieldType.LONG_TEXT,
                        FieldType.EMAIL,
                        FieldType.URL,
                        FieldType.INTEGER,
                        FieldType.NUMBER,
                        FieldType.DECIMAL,
                        FieldType.SELECT,
                    )
                ),
                module_filter(db, user, AccessLevel.READ, Module.id),
            )
        ).all()
        resolvers: dict[UUID, FieldDisplayResolver] = {}
        for target_id, data, field in records:
            value = data.get(str(field.id))
            if value is None:
                continue
            if field.id not in resolvers:
                resolvers[field.id] = FieldDisplayResolver(db, field.module_id, (field,))
            label = resolvers[field.id].label(field, value).strip()
            if label and label not in {UNAVAILABLE_OPTION, REDACTED}:
                current[("records", target_id)] = label

    # Other domains keep their permitted name/title snapshots or the honest
    # fallback. Their historical department is not authority for a live lookup.
    for log in logs:
        if _snapshot_label(log) is None and log.entity_id is not None:
            if label := current.get((log.entity_type, log.entity_id), "").strip():
                if label != REDACTED:
                    labels[log.id] = label
    return labels
