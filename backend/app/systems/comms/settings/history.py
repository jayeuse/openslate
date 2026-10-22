"""Actual audit history and protected restoration on the existing settings resources."""

import hashlib
import json
from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from pydantic import ValidationError
from sqlalchemy import select

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.common.listing import (
    ListQuerySpec,
    StandardListRequest,
    StandardListResponse,
    execute_standard_list,
)
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import error
from app.systems.comms.conversations.service import private, transaction
from app.systems.comms.jobs.protected import admin, password_admin
from app.systems.comms.messages.interaction_schemas import TimeList, TimeSort
from app.systems.comms.realtime.events import organization_event
from app.systems.comms.settings import history_replay, service
from app.systems.comms.settings.resolution import Scope
from app.systems.comms.settings.schemas import (
    ConfigurationHistory,
    ConfigurationRestorePreview,
    ConfigurationRestorePreviewRequest,
    ConfigurationRestoreRequest,
    ConfigurationSnapshot,
)
from app.systems.manage.audit.models import AuditLog
from app.systems.sandbox.lifecycle.exceptions import LifecycleError
from app.systems.sandbox.lifecycle.service import (
    challenge_impact_digest,
    issue_challenge,
    verify_challenge,
)

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
Match = Annotated[str | None, Header(alias="If-Match")]
Page = StandardListResponse[ConfigurationHistory]
Params = Annotated[TimeList, Query()]
router = APIRouter(
    prefix="/comms/settings", tags=["comms"], dependencies=[Depends(get_current_membership)]
)


def authorize(db: AuditSession, actor: User, scope: Scope, *, write: bool = False) -> None:
    admin(db, actor)
    service.lock_scope(db, actor, scope, write=write)


def load(db: AuditSession, scope: Scope, identity: UUID) -> ConfigurationHistory:
    item = history_replay.history(db, scope).get(identity)
    if item is None:
        raise error("comms_not_found", "Configuration history not found")
    return item


def listing(db: AuditSession, actor: User, scope: Scope, params: TimeList, http: Response) -> Any:
    authorize(db, actor, scope)
    entries = history_replay.history(db, scope)
    page = execute_standard_list(
        db,
        select(AuditLog).where(
            AuditLog.org_id == bound_organization(db),
            AuditLog.id.in_(entries),
        ),
        StandardListRequest[TimeSort](**params.model_dump()),
        ListQuerySpec(
            sort_fields={
                TimeSort.CREATED: AuditLog.created_at.expression,
                TimeSort.UPDATED: AuditLog.created_at.expression,
            },
            default_sort=TimeSort.CREATED,
            tie_breaker=AuditLog.id.expression,
        ),
    )
    private(http)
    return Page(items=[entries[row.id] for row in page.items], pagination=page.pagination)


def item(
    db: AuditSession, actor: User, scope: Scope, identity: UUID, http: Response
) -> ConfigurationHistory:
    authorize(db, actor, scope)
    private(http)
    return load(db, scope, identity)


def binding(
    db: AuditSession, actor: User, scope: Scope, entry: ConfigurationHistory, tag: str
) -> str:
    value = {
        "purpose": "comms-configuration-restore-v1",
        "org": str(bound_organization(db)),
        "actor": str(actor.id),
        "scope": scope,
        "history": entry.model_dump(mode="json"),
        "etag": tag,
    }
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def validate(db: AuditSession, scope: Scope, proposed: ConfigurationSnapshot) -> None:
    try:
        service.validate_snapshot(db, scope, proposed)
    except ValidationError as exc:
        raise error(
            "comms_settings_invalid", "Historical configuration is not valid for writing", 422
        ) from exc


def confirmation_failure(status: int) -> HTTPException:
    if status == 429:
        refused = error("comms_rate_limited", "Wait before confirming again", 429)
        # The existing confirmation boundary supplies no provider retry deadline.
        refused.headers = {"Retry-After": "60"}
        return refused
    if status >= 500:
        return error("comms_unavailable", "Restore confirmation is unavailable", 503)
    code = {
        403: "comms_fresh_admin_required",
        404: "comms_not_found",
        422: "comms_invalid_input",
    }.get(status, "comms_conflict")
    return error(
        code, "Restore confirmation is unavailable", status if status in (403, 404, 422) else 409
    )


def preview(
    db: AuditSession,
    actor: User,
    scope: Scope,
    payload: ConfigurationRestorePreviewRequest,
    http: Response,
    if_match: str | None,
) -> ConfigurationRestorePreview:
    authorize(db, actor, scope)
    service.match(db, scope, if_match)
    load(db, scope, payload.history_id)
    try:
        actor = password_admin(db, actor, payload.password)
    except HTTPException as exc:
        if exc.status_code == 429:
            raise confirmation_failure(429) from exc
        raise
    authorize(db, actor, scope)
    service.match(db, scope, if_match)
    entry = load(db, scope, payload.history_id)
    validate(db, scope, entry.before)
    before = history_replay.current_snapshot(db, scope)
    tag = service.version(db, scope)
    try:
        issued = issue_challenge(
            db,
            actor.id,
            "purge",
            "comms_configuration",
            scope.get("id") or bound_organization(db),
            binding(db, actor, scope, entry, tag),
            hex_token=True,
        )
    except LifecycleError as exc:
        raise confirmation_failure(int(exc.status_code)) from exc
    private(http)
    http.headers["ETag"] = tag
    return ConfigurationRestorePreview.model_validate(
        {
            "org_id": bound_organization(db),
            "history_id": entry.id,
            "scope": scope,
            "before": before,
            "after": entry.before,
            "preview_digest": issued.token,
            "expires_at": issued.expires_at,
        }
    )


def restore(
    db: AuditSession,
    actor: User,
    scope: Scope,
    payload: ConfigurationRestoreRequest,
    http: Response,
    if_match: str | None,
) -> ConfigurationSnapshot:
    with transaction(db):
        authorize(db, actor, scope, write=True)
        service.match(db, scope, if_match)
        entry = load(db, scope, payload.history_id)
        expected = binding(db, actor, scope, entry, service.version(db, scope))
        identity = scope.get("id") or bound_organization(db)
        actor_id, email = actor.id, actor.email
        try:
            saved = challenge_impact_digest(
                db, payload.preview_digest, actor_id, "purge", "comms_configuration", identity
            )
            if saved != expected:
                raise error("comms_conflict", "Restore preview no longer matches", 409)
            verify_challenge(
                db,
                payload.preview_digest,
                actor_id,
                "purge",
                "comms_configuration",
                identity,
                saved,
                email,
                payload.password,
            )
        except LifecycleError as exc:
            raise confirmation_failure(int(exc.status_code)) from exc
        current = db.get(User, actor_id, populate_existing=True)
        if current is None:
            raise error("comms_admin_required", "Administrator unavailable", 403)
        authorize(db, current, scope, write=True)
        service.match(db, scope, if_match)
        entry = load(db, scope, payload.history_id)
        if binding(db, current, scope, entry, service.version(db, scope)) != expected:
            raise error("comms_conflict", "Restore preview no longer matches", 409)
        validate(db, scope, entry.before)
        if service.restore_snapshot(db, current, scope, entry.before):
            organization_event(db, "grants")
        service.headers(db, scope, http)
        result = history_replay.current_snapshot(db, scope)
    return result


@router.get("/workspace/history", response_model=Page, response_model_exclude_none=True)
def list_workspace(db: DB, actor: Actor, params: Params, http: Response) -> Any:
    return listing(db, actor, {"kind": "workspace"}, params, http)


@router.get(
    "/category/{category_id}/history", response_model=Page, response_model_exclude_none=True
)
def list_category(category_id: UUID, db: DB, actor: Actor, params: Params, http: Response) -> Any:
    return listing(db, actor, {"kind": "category", "id": category_id}, params, http)


@router.get(
    "/channel/{conversation_id}/history", response_model=Page, response_model_exclude_none=True
)
def list_channel(
    conversation_id: UUID, db: DB, actor: Actor, params: Params, http: Response
) -> Any:
    return listing(db, actor, {"kind": "channel", "id": conversation_id}, params, http)


@router.get(
    "/workspace/history/{history_id}",
    response_model=ConfigurationHistory,
    response_model_exclude_none=True,
)
def get_workspace(history_id: UUID, db: DB, actor: Actor, http: Response) -> ConfigurationHistory:
    return item(db, actor, {"kind": "workspace"}, history_id, http)


@router.get(
    "/category/{category_id}/history/{history_id}",
    response_model=ConfigurationHistory,
    response_model_exclude_none=True,
)
def get_category(
    category_id: UUID, history_id: UUID, db: DB, actor: Actor, http: Response
) -> ConfigurationHistory:
    return item(db, actor, {"kind": "category", "id": category_id}, history_id, http)


@router.get(
    "/channel/{conversation_id}/history/{history_id}",
    response_model=ConfigurationHistory,
    response_model_exclude_none=True,
)
def get_channel(
    conversation_id: UUID, history_id: UUID, db: DB, actor: Actor, http: Response
) -> ConfigurationHistory:
    return item(db, actor, {"kind": "channel", "id": conversation_id}, history_id, http)


@router.post(
    "/workspace/restoration-preview",
    response_model=ConfigurationRestorePreview,
    response_model_exclude_none=True,
)
def preview_workspace(
    payload: ConfigurationRestorePreviewRequest,
    db: DB,
    actor: Actor,
    http: Response,
    if_match: Match = None,
) -> ConfigurationRestorePreview:
    return preview(db, actor, {"kind": "workspace"}, payload, http, if_match)


@router.post(
    "/category/{category_id}/restoration-preview",
    response_model=ConfigurationRestorePreview,
    response_model_exclude_none=True,
)
def preview_category(
    category_id: UUID,
    payload: ConfigurationRestorePreviewRequest,
    db: DB,
    actor: Actor,
    http: Response,
    if_match: Match = None,
) -> ConfigurationRestorePreview:
    return preview(db, actor, {"kind": "category", "id": category_id}, payload, http, if_match)


@router.post(
    "/channel/{conversation_id}/restoration-preview",
    response_model=ConfigurationRestorePreview,
    response_model_exclude_none=True,
)
def preview_channel(
    conversation_id: UUID,
    payload: ConfigurationRestorePreviewRequest,
    db: DB,
    actor: Actor,
    http: Response,
    if_match: Match = None,
) -> ConfigurationRestorePreview:
    return preview(db, actor, {"kind": "channel", "id": conversation_id}, payload, http, if_match)


@router.post(
    "/workspace/restoration", response_model=ConfigurationSnapshot, response_model_exclude_none=True
)
def restore_workspace(
    payload: ConfigurationRestoreRequest,
    db: DB,
    actor: Actor,
    http: Response,
    if_match: Match = None,
) -> ConfigurationSnapshot:
    return restore(db, actor, {"kind": "workspace"}, payload, http, if_match)


@router.post(
    "/category/{category_id}/restoration",
    response_model=ConfigurationSnapshot,
    response_model_exclude_none=True,
)
def restore_category(
    category_id: UUID,
    payload: ConfigurationRestoreRequest,
    db: DB,
    actor: Actor,
    http: Response,
    if_match: Match = None,
) -> ConfigurationSnapshot:
    return restore(db, actor, {"kind": "category", "id": category_id}, payload, http, if_match)


@router.post(
    "/channel/{conversation_id}/restoration",
    response_model=ConfigurationSnapshot,
    response_model_exclude_none=True,
)
def restore_channel(
    conversation_id: UUID,
    payload: ConfigurationRestoreRequest,
    db: DB,
    actor: Actor,
    http: Response,
    if_match: Match = None,
) -> ConfigurationSnapshot:
    return restore(db, actor, {"kind": "channel", "id": conversation_id}, payload, http, if_match)
