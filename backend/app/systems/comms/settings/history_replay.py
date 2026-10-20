"""Project actual configuration audit mutations into complete, scope-bound operation snapshots."""

import json
from copy import deepcopy
from typing import Any, cast
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import Table, and_, false, or_, select, true, union
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import ColumnElement

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.membership import bound_organization
from app.systems.comms.access import error
from app.systems.comms.settings.models import CommsCapabilityGrant, CommsSettingLock, CommsSettings
from app.systems.comms.settings.resolution import Scope, SettingsValues
from app.systems.comms.settings.schemas import ConfigurationHistory, ConfigurationSnapshot
from app.systems.manage.audit.models import AuditAction, AuditLog
from app.systems.manage.audit.snapshots import AUDIT_METADATA_FIELDS, serialize_value

TABLES: dict[str, Table] = {
    model.__tablename__: cast(Table, model.__table__)
    for model in (CommsSettings, CommsCapabilityGrant, CommsSettingLock)
}
# Align with the existing synchronous audit export bound; no truncation or stored entitlement.
RECONSTRUCTION_LIMIT = 10_000
Graph = dict[str, dict[UUID, dict[str, Any]]]


def _scope_clause(table: Table, scope: Scope) -> ColumnElement[bool]:
    if table.name == "comms_setting_locks":
        return true() if scope["kind"] == "workspace" else false()
    result = table.c.scope == scope["kind"]
    if scope["kind"] != "workspace":
        result &= (
            table.c.category_id == scope["id"]
            if scope["kind"] == "category"
            else table.c.conversation_id == scope["id"]
        )
    return result


def _json_scope(value: Any, scope: Scope) -> ColumnElement[bool]:
    expression: ColumnElement[bool] = value["scope"].astext == scope["kind"]
    if scope["kind"] != "workspace":
        field = "category_id" if scope["kind"] == "category" else "conversation_id"
        expression &= value[field].astext == str(scope["id"])
    return expression


def _belongs(table: str, value: dict[str, Any], scope: Scope) -> bool:
    if table == "comms_setting_locks":
        return scope["kind"] == "workspace"
    if value.get("scope") != scope["kind"]:
        return False
    field = "category_id" if scope["kind"] == "category" else "conversation_id"
    return scope["kind"] == "workspace" or str(value.get(field)) == str(scope["id"])


def snapshot(graph: Graph, scope: Scope) -> ConfigurationSnapshot:
    rows = {
        table: [
            value
            for value in items.values()
            if not value.get("is_deleted", False)
            and value.get("deleted_at") is None
            and _belongs(table, value, scope)
        ]
        for table, items in graph.items()
    }
    settings = rows["comms_settings"]
    if len(settings) > 1:
        raise error("comms_unavailable", "Configuration history cannot be reconstructed", 503)
    values = deepcopy(settings[0]["values"]) if settings else {}
    if not isinstance(values, dict):
        raise error("comms_unavailable", "Configuration history is incomplete", 503)
    ordinary: dict[str, Any] = {}
    for key, value in values.items():
        if key == "dm_rule" or key not in SettingsValues.model_fields:
            continue
        try:
            ordinary.update(
                SettingsValues.model_validate({key: value}).model_dump(
                    mode="json",
                    exclude_unset=True,
                )
            )
        except ValidationError:
            continue  # Same per-key read tolerance as settings, never a write-validation waiver.
    caps = rows["comms_capability_grants"]
    result: dict[str, Any] = {
        "settings": ordinary,
        "capabilities": {
            "scope": scope,
            "everyone": {
                row["capability"]: row["granted"] for row in caps if row["subject"] == "everyone"
            },
            "group_grants": sorted(
                (
                    {
                        "group_id": row["group_id"],
                        "capability": row["capability"],
                    }
                    for row in caps
                    if row["subject"] == "group"
                ),
                key=lambda row: (str(row["capability"]), str(row["group_id"])),
            ),
        },
    }
    if scope["kind"] == "workspace":
        rule = values.get("dm_rule", "everyone")
        result.update(
            dm_rule=rule if rule in ("everyone", "shared-channel", "none") else "everyone",
            setting_locks=sorted(
                row["key"] for row in rows["comms_setting_locks"] if row["namespace"] == "setting"
            ),
            capability_locks=sorted(
                row["key"]
                for row in rows["comms_setting_locks"]
                if row["namespace"] == "capability"
            ),
        )
    return ConfigurationSnapshot.model_validate(result)


def current_snapshot(db: Session, scope: Scope) -> ConfigurationSnapshot:
    graph: Graph = {}
    for name, table in TABLES.items():
        graph[name] = {
            row["id"]: dict(row)
            for row in db.execute(
                select(table).where(
                    table.c.org_id == bound_organization_column(),
                    _scope_clause(table, scope),
                )
            ).mappings()
        }
    return snapshot(graph, scope)


def _undo(current: dict[str, Any], before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(current)
    for key in before.keys() | after.keys():
        if key not in before:
            result.pop(key, None)
        elif isinstance(before[key], dict) and isinstance(after.get(key), dict):
            result[key] = _undo(result.get(key) or {}, before[key], after[key])
        else:
            result[key] = deepcopy(before[key])
    return result


def _equal(left: Any, right: Any) -> bool:
    return json.dumps(left, sort_keys=True) == json.dumps(right, sort_keys=True)


def _after_matches(current: dict[str, Any], before: dict[str, Any], after: dict[str, Any]) -> bool:
    if any(key in current for key in before.keys() - after.keys()):
        return False
    for key, expected in after.items():
        if key not in current:
            return False
        if isinstance(expected, dict) and isinstance(before.get(key), dict):
            if not isinstance(current[key], dict) or not _after_matches(
                current[key], before[key], expected
            ):
                return False
        elif not _equal(current[key], expected):
            return False
    return True


def _created_state(current: dict[str, Any]) -> Any:
    return serialize_value(
        {
            key: value
            for key, value in current.items()
            if key not in AUDIT_METADATA_FIELDS
            and not (key == "is_deleted" and value is not True)
            and not (key == "deleted_at" and value is None)
        }
    )


def history(db: Session, scope: Scope) -> dict[UUID, ConfigurationHistory]:
    """Caller holds the current scope and consulted-ancestor locks across this read."""
    graph: Graph = {}
    clauses = []
    for name, table in TABLES.items():
        captured_scope = (
            (true() if scope["kind"] == "workspace" else false())
            if name == "comms_setting_locks"
            else or_(
                _json_scope(AuditLog.before, scope),
                _json_scope(AuditLog.after, scope),
            )
        )
        identities = union(
            select(table.c.id.label("id"))
            .where(table.c.org_id == bound_organization_column(), _scope_clause(table, scope))
            .correlate(None),
            select(AuditLog.entity_id.label("id"))
            .where(
                AuditLog.org_id == bound_organization_column(),
                AuditLog.entity_type == name,
                captured_scope,
            )
            .correlate(None),
        ).subquery()
        ids = select(identities.c.id)
        rows = (
            db.execute(
                select(table)
                .where(table.c.org_id == bound_organization_column(), table.c.id.in_(ids))
                .limit(RECONSTRUCTION_LIMIT + 1)
            )
            .mappings()
            .all()
        )
        if len(rows) > RECONSTRUCTION_LIMIT:
            raise error(
                "comms_unavailable", "Configuration history exceeds the synchronous read bound", 503
            )
        graph[name] = {row["id"]: dict(row) for row in rows}
        clauses.append(and_(AuditLog.entity_type == name, AuditLog.entity_id.in_(ids)))
    audits = list(
        db.scalars(
            select(AuditLog)
            .where(
                AuditLog.org_id == bound_organization_column(),
                or_(*clauses),
            )
            .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
            .limit(RECONSTRUCTION_LIMIT + 1)
        )
    )
    if len(audits) > RECONSTRUCTION_LIMIT:
        raise error(
            "comms_unavailable", "Configuration history exceeds the synchronous read bound", 503
        )
    groups: dict[tuple[UUID, UUID | None], ConfigurationHistory] = {}
    for audit in audits:
        assert audit.entity_id is not None
        after = snapshot(graph, scope)
        objects = graph[audit.entity_type]
        if audit.action == AuditAction.CREATE:
            if audit.entity_id not in objects or not _equal(
                _created_state(objects[audit.entity_id]), audit.after
            ):
                raise error(
                    "comms_unavailable", "Configuration history does not match stored state", 503
                )
            objects.pop(audit.entity_id, None)
        elif audit.action == AuditAction.DELETE and audit.after is None:
            if audit.before is None or audit.entity_id in objects:
                raise error("comms_unavailable", "Configuration history is incomplete", 503)
            objects[audit.entity_id] = deepcopy(audit.before)
        else:
            if audit.entity_id not in objects:
                raise error("comms_unavailable", "Configuration history is incomplete", 503)
            if not _after_matches(
                serialize_value(objects[audit.entity_id]), audit.before or {}, audit.after or {}
            ):
                raise error(
                    "comms_unavailable", "Configuration history does not match stored state", 503
                )
            objects[audit.entity_id] = _undo(
                objects[audit.entity_id], audit.before or {}, audit.after or {}
            )
        before = snapshot(graph, scope)
        if before == after or audit.performed_by is None:
            continue
        key = (audit.request_id or audit.id, audit.performed_by)
        if key in groups:
            groups[key].before = before
        else:
            groups[key] = ConfigurationHistory(
                id=audit.id,
                org_id=bound_organization(db),
                actor_id=audit.performed_by,
                scope=scope,
                before=before,
                after=after,
                created_at=audit.created_at,
                updated_at=audit.created_at,
            )
    return {entry.id: entry for entry in groups.values() if entry.before != entry.after}
