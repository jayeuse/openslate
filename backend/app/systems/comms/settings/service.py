"""Resource-locked ordinary configuration writes composed with the existing S16 policy."""

import json
from hashlib import sha256
from typing import Any, Literal

from fastapi import Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import error, require_conversation_access
from app.systems.comms.capabilities import (
    scope_management_decision,
    validate_capability_configuration,
)
from app.systems.comms.conversations.models import CommsCategory, CommsConversation
from app.systems.comms.conversations.service import private
from app.systems.comms.settings.models import CommsCapabilityGrant, CommsSettingLock, CommsSettings
from app.systems.comms.settings.resolution import (
    Scope,
    ScopeContext,
    _paired_hours,
    locked_keys,
    resolve_settings,
    scope_clause,
    scope_context,
    validate_settings_patch,
)
from app.systems.comms.settings.schemas import (
    CapabilityConfiguration,
    SettingsResponse,
    WorkspaceSettingsResponse,
)
from app.systems.manage.workspace.models import WorkspaceProfile


def read_scope(db: Session, actor: User, scope: Scope) -> ScopeContext:
    context = scope_context(db, scope)
    if scope["kind"] == "channel":
        require_conversation_access(db, actor, scope["id"], "read")
    return context


def lock_scope(db: Session, actor: User, scope: Scope, *, write: bool = True) -> None:
    read_scope(db, actor, scope)
    # Structure writers already lock the resource. Keep that ordering and protect
    # ancestor settings/locks with shared ancestor locks; unrelated channels can write concurrently.
    if scope["kind"] != "workspace":
        model = CommsCategory if scope["kind"] == "category" else CommsConversation
        db.scalar(
            select(model)
            .where(model.org_id == bound_organization_column(), model.id == scope["id"])
            .with_for_update(read=not write)
            .execution_options(populate_existing=True)
        )
    db.scalar(
        select(WorkspaceProfile.id)
        .where(WorkspaceProfile.id == bound_organization_column())
        .with_for_update(read=not write or scope["kind"] != "workspace")
    )
    context = read_scope(db, actor, scope)
    if scope["kind"] == "channel":
        for ancestor in context.chain:
            if ancestor["kind"] == "category":
                db.scalar(
                    select(CommsCategory)
                    .where(
                        CommsCategory.org_id == bound_organization_column(),
                        CommsCategory.id == ancestor["id"],
                    )
                    .with_for_update(read=True)
                    .execution_options(populate_existing=True)
                )
    if write and not scope_management_decision(db, actor, scope)["allowed"]:
        raise error("comms_capability_denied", "Configuration change is not permitted", 403)


def version(db: Session, scope: Scope) -> str:
    db.flush()
    context = scope_context(db, scope)
    payload: dict[str, Any] = {
        "org_id": bound_organization(db),
        "scope": scope,
        "chain": context.chain,
    }
    for model in (CommsSettings, CommsCapabilityGrant):
        payload[model.__tablename__] = [
            dict(row)
            for row in db.execute(
                select(model.__table__)
                .where(
                    or_(*(scope_clause(model, ancestor) for ancestor in context.chain)),
                )
                .order_by(model.id)
            ).mappings()
        ]
    payload["locks"] = [
        dict(row)
        for row in db.execute(
            select(CommsSettingLock.__table__)
            .where(
                CommsSettingLock.org_id == bound_organization_column(),
                CommsSettingLock.is_deleted.is_(False),
            )
            .order_by(CommsSettingLock.id)
        ).mappings()
    ]
    return '"' + sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest() + '"'


def match(db: Session, scope: Scope, value: str | None) -> None:
    if value is None:
        raise error("comms_precondition_required", "If-Match is required", 428)
    if value != version(db, scope):
        raise error("comms_precondition_failed", "Configuration changed", 412)


def headers(db: Session, scope: Scope, response: Response) -> None:
    private(response)
    response.headers["ETag"] = version(db, scope)


def settings(db: Session, scope: Scope) -> SettingsResponse | WorkspaceSettingsResponse:
    value = resolve_settings(db, scope)
    model = WorkspaceSettingsResponse if scope["kind"] == "workspace" else SettingsResponse
    return model.model_validate(value)


def _settings_row(db: Session, scope: Scope) -> CommsSettings | None:
    return db.scalar(
        select(CommsSettings)
        .where(scope_clause(CommsSettings, scope))
        .execution_options(populate_existing=True)
    )


def patch_settings(db: Session, scope: Scope, payload: dict[str, Any]) -> None:
    values = validate_settings_patch(db, scope, payload)
    row = _settings_row(db, scope)
    if row is None:
        row = CommsSettings(
            org_id=bound_organization(db),
            scope=scope["kind"],
            category_id=scope.get("id") if scope["kind"] == "category" else None,
            conversation_id=scope.get("id") if scope["kind"] == "channel" else None,
            values={},
        )
        db.add(row)
    row.values = {**row.values, **values}


def reset_settings(db: Session, scope: Scope, keys: list[str]) -> None:
    if scope["kind"] != "workspace" and set(keys) & locked_keys(db, "setting"):
        raise error("comms_settings_locked", "Workspace setting is locked", 403)
    row = _settings_row(db, scope)
    values = {key: value for key, value in (row.values if row else {}).items() if key not in keys}
    if not _paired_hours(values):
        raise error("comms_settings_invalid", "Reset both quiet-hour endpoints", 422)
    if row is not None:
        row.values = values


def configuration(db: Session, scope: Scope) -> CapabilityConfiguration:
    rows = db.scalars(
        select(CommsCapabilityGrant)
        .where(scope_clause(CommsCapabilityGrant, scope))
        .order_by(CommsCapabilityGrant.capability, CommsCapabilityGrant.group_id)
    ).all()
    return CapabilityConfiguration.model_validate(
        {
            "scope": scope,
            "everyone": {row.capability: row.granted for row in rows if row.subject == "everyone"},
            "group_grants": [
                {"group_id": row.group_id, "capability": row.capability}
                for row in rows
                if row.subject == "group"
            ],
        }
    )


def replace_configuration(db: Session, scope: Scope, payload: CapabilityConfiguration) -> None:
    normalized = validate_capability_configuration(db, scope, payload.model_dump(mode="json"))
    for row in db.scalars(
        select(CommsCapabilityGrant).where(scope_clause(CommsCapabilityGrant, scope))
    ):
        db.delete(row)
    db.flush()
    owner = {
        "org_id": bound_organization(db),
        "scope": scope["kind"],
        "category_id": scope.get("id") if scope["kind"] == "category" else None,
        "conversation_id": scope.get("id") if scope["kind"] == "channel" else None,
    }
    for grant in normalized["group_grants"]:
        db.add(CommsCapabilityGrant(**owner, subject="group", granted=True, **grant))
    for capability, enabled in normalized["everyone"].items():
        db.add(
            CommsCapabilityGrant(
                **owner, subject="everyone", capability=capability, granted=enabled
            )
        )


def replace_locks(
    db: Session, namespace: Literal["setting", "capability"], keys: list[str]
) -> None:
    existing = db.scalars(
        select(CommsSettingLock).where(
            CommsSettingLock.org_id == bound_organization_column(),
            CommsSettingLock.namespace == namespace,
            CommsSettingLock.is_deleted.is_(False),
        )
    ).all()
    for row in existing:
        if row.key not in keys:
            db.delete(row)
    known = {row.key for row in existing}
    for key in keys:
        if key not in known:
            db.add(CommsSettingLock(org_id=bound_organization(db), namespace=namespace, key=key))
