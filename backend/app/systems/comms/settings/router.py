"""S17 ordinary settings, locks, grants and canonical policy projections."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Response

from app.common.dependencies.auth import get_account_user, get_current_membership
from app.core.database.session import AuditSession, get_db
from app.systems.access.users.models import User
from app.systems.comms.capabilities import channel_creation_check, inspect_capabilities
from app.systems.comms.conversations.service import private, transaction
from app.systems.comms.realtime.events import organization_event
from app.systems.comms.settings import service
from app.systems.comms.settings.resolution import Scope, locked_keys
from app.systems.comms.settings.schemas import (
    CapabilityCheck,
    CapabilityConfiguration,
    CapabilityLocks,
    CreationCheck,
    CreationQuery,
    SettingLocks,
    SettingsPatch,
    SettingsReset,
    SettingsResponse,
    WorkspaceSettingsResponse,
)

DB = Annotated[AuditSession, Depends(get_db)]
Actor = Annotated[User, Depends(get_account_user)]
Match = Annotated[str | None, Header(alias="If-Match")]
WORKSPACE: Scope = {"kind": "workspace"}
VERSIONED: dict[int | str, dict[str, Any]] = {
    200: {"headers": {"ETag": {"schema": {"type": "string"}}}}
}
CONDITIONAL = {
    **VERSIONED,
    428: {"description": "If-Match is required"},
    412: {"description": "Configuration changed"},
}
router = APIRouter(
    prefix="/comms",
    tags=["comms"],
    dependencies=[Depends(get_current_membership)],
    responses={
        403: {"description": "Current scope operation is not permitted"},
        404: {"description": "Absent or unreadable resource"},
        503: {"description": "Configuration operation unavailable"},
    },
)


def _get(
    scope: Scope, db: AuditSession, actor: User, response: Response
) -> SettingsResponse | WorkspaceSettingsResponse:
    service.lock_scope(db, actor, scope, write=False)
    result = service.settings(db, scope)
    service.headers(db, scope, response)
    return result


def _change(
    scope: Scope,
    payload: SettingsPatch | SettingsReset,
    db: AuditSession,
    actor: User,
    response: Response,
    if_match: str | None,
) -> SettingsResponse | WorkspaceSettingsResponse:
    with transaction(db):
        service.lock_scope(db, actor, scope)
        service.match(db, scope, if_match)
        if isinstance(payload, SettingsReset):
            service.reset_settings(db, scope, payload.keys)
        else:
            service.patch_settings(db, scope, payload.model_dump(mode="json", exclude_unset=True))
        db.flush()
        result = service.settings(db, scope)
        service.headers(db, scope, response)
        organization_event(db, "grants")
    return result


@router.get("/settings/workspace", response_model=WorkspaceSettingsResponse, responses=VERSIONED)
def get_workspace(db: DB, actor: Actor, response: Response) -> Any:
    return _get(WORKSPACE, db, actor, response)


@router.patch(
    "/settings/workspace", response_model=WorkspaceSettingsResponse, responses=CONDITIONAL
)
def patch_workspace(
    payload: SettingsPatch, db: DB, actor: Actor, response: Response, if_match: Match = None
) -> Any:
    return _change(WORKSPACE, payload, db, actor, response, if_match)


@router.post(
    "/settings/workspace/reset", response_model=WorkspaceSettingsResponse, responses=CONDITIONAL
)
def reset_workspace(
    payload: SettingsReset, db: DB, actor: Actor, response: Response, if_match: Match = None
) -> Any:
    return _change(WORKSPACE, payload, db, actor, response, if_match)


@router.put(
    "/settings/workspace/locks", response_model=WorkspaceSettingsResponse, responses=CONDITIONAL
)
def set_locks(
    payload: SettingLocks, db: DB, actor: Actor, response: Response, if_match: Match = None
) -> Any:
    with transaction(db):
        service.lock_scope(db, actor, WORKSPACE)
        service.match(db, WORKSPACE, if_match)
        service.replace_locks(db, "setting", payload.keys)
        db.flush()
        result = service.settings(db, WORKSPACE)
        service.headers(db, WORKSPACE, response)
        organization_event(db, "grants")
    return result


def _get_capabilities(
    scope: Scope, db: AuditSession, actor: User, response: Response
) -> CapabilityConfiguration:
    service.lock_scope(db, actor, scope, write=False)
    result = service.configuration(db, scope)
    service.headers(db, scope, response)
    return result


def _set_capabilities(
    scope: Scope,
    payload: CapabilityConfiguration,
    db: AuditSession,
    actor: User,
    response: Response,
    if_match: str | None,
) -> CapabilityConfiguration:
    with transaction(db):
        service.lock_scope(db, actor, scope)
        service.match(db, scope, if_match)
        service.replace_configuration(db, scope, payload)
        db.flush()
        result = service.configuration(db, scope)
        service.headers(db, scope, response)
        organization_event(db, "grants")
    return result


@router.get(
    "/settings/workspace/capabilities", response_model=CapabilityConfiguration, responses=VERSIONED
)
def get_workspace_capabilities(db: DB, actor: Actor, response: Response) -> CapabilityConfiguration:
    return _get_capabilities(WORKSPACE, db, actor, response)


@router.put(
    "/settings/workspace/capabilities",
    response_model=CapabilityConfiguration,
    responses=CONDITIONAL,
)
def set_workspace_capabilities(
    payload: CapabilityConfiguration,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> CapabilityConfiguration:
    return _set_capabilities(WORKSPACE, payload, db, actor, response, if_match)


@router.get(
    "/settings/workspace/capability-locks", response_model=CapabilityLocks, responses=VERSIONED
)
def get_capability_locks(db: DB, actor: Actor, response: Response) -> CapabilityLocks:
    service.lock_scope(db, actor, WORKSPACE, write=False)
    service.headers(db, WORKSPACE, response)
    return CapabilityLocks(capabilities=sorted(locked_keys(db, "capability")))


@router.put(
    "/settings/workspace/capability-locks", response_model=CapabilityLocks, responses=CONDITIONAL
)
def set_capability_locks(
    payload: CapabilityLocks, db: DB, actor: Actor, response: Response, if_match: Match = None
) -> CapabilityLocks:
    with transaction(db):
        service.lock_scope(db, actor, WORKSPACE)
        service.match(db, WORKSPACE, if_match)
        service.replace_locks(db, "capability", payload.capabilities)
        db.flush()
        result = CapabilityLocks(capabilities=sorted(locked_keys(db, "capability")))
        service.headers(db, WORKSPACE, response)
        organization_event(db, "grants")
    return result


@router.get(
    "/settings/category/{category_id}", response_model=SettingsResponse, responses=VERSIONED
)
def get_category(category_id: UUID, db: DB, actor: Actor, response: Response) -> Any:
    return _get({"kind": "category", "id": category_id}, db, actor, response)


@router.patch(
    "/settings/category/{category_id}", response_model=SettingsResponse, responses=CONDITIONAL
)
def patch_category(
    category_id: UUID,
    payload: SettingsPatch,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> Any:
    return _change({"kind": "category", "id": category_id}, payload, db, actor, response, if_match)


@router.post(
    "/settings/category/{category_id}/reset", response_model=SettingsResponse, responses=CONDITIONAL
)
def reset_category(
    category_id: UUID,
    payload: SettingsReset,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> Any:
    return _change({"kind": "category", "id": category_id}, payload, db, actor, response, if_match)


@router.get(
    "/settings/category/{category_id}/capabilities",
    response_model=CapabilityConfiguration,
    responses=VERSIONED,
)
def get_category_capabilities(
    category_id: UUID, db: DB, actor: Actor, response: Response
) -> CapabilityConfiguration:
    return _get_capabilities({"kind": "category", "id": category_id}, db, actor, response)


@router.put(
    "/settings/category/{category_id}/capabilities",
    response_model=CapabilityConfiguration,
    responses=CONDITIONAL,
)
def set_category_capabilities(
    category_id: UUID,
    payload: CapabilityConfiguration,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> CapabilityConfiguration:
    return _set_capabilities(
        {"kind": "category", "id": category_id}, payload, db, actor, response, if_match
    )


@router.get(
    "/settings/channel/{conversation_id}", response_model=SettingsResponse, responses=VERSIONED
)
def get_channel(conversation_id: UUID, db: DB, actor: Actor, response: Response) -> Any:
    return _get({"kind": "channel", "id": conversation_id}, db, actor, response)


@router.patch(
    "/settings/channel/{conversation_id}", response_model=SettingsResponse, responses=CONDITIONAL
)
def patch_channel(
    conversation_id: UUID,
    payload: SettingsPatch,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> Any:
    return _change(
        {"kind": "channel", "id": conversation_id}, payload, db, actor, response, if_match
    )


@router.post(
    "/settings/channel/{conversation_id}/reset",
    response_model=SettingsResponse,
    responses=CONDITIONAL,
)
def reset_channel(
    conversation_id: UUID,
    payload: SettingsReset,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> Any:
    return _change(
        {"kind": "channel", "id": conversation_id}, payload, db, actor, response, if_match
    )


@router.get(
    "/settings/channel/{conversation_id}/capabilities",
    response_model=CapabilityConfiguration,
    responses=VERSIONED,
)
def get_channel_capabilities(
    conversation_id: UUID, db: DB, actor: Actor, response: Response
) -> CapabilityConfiguration:
    return _get_capabilities({"kind": "channel", "id": conversation_id}, db, actor, response)


@router.put(
    "/settings/channel/{conversation_id}/capabilities",
    response_model=CapabilityConfiguration,
    responses=CONDITIONAL,
)
def set_channel_capabilities(
    conversation_id: UUID,
    payload: CapabilityConfiguration,
    db: DB,
    actor: Actor,
    response: Response,
    if_match: Match = None,
) -> CapabilityConfiguration:
    return _set_capabilities(
        {"kind": "channel", "id": conversation_id}, payload, db, actor, response, if_match
    )


@router.get("/conversations/{conversation_id}/capabilities", response_model=CapabilityCheck)
def get_capabilities(conversation_id: UUID, db: DB, actor: Actor, response: Response) -> Any:
    private(response)
    return inspect_capabilities(db, actor, conversation_id)


@router.get(
    "/conversations/{conversation_id}/capabilities/{user_id}", response_model=CapabilityCheck
)
def check_person(
    conversation_id: UUID, user_id: UUID, db: DB, actor: Actor, response: Response
) -> Any:
    private(response)
    return inspect_capabilities(db, actor, conversation_id, user_id=user_id)


@router.get("/capabilities/channel-creation", response_model=CreationCheck)
def creation(
    db: DB, actor: Actor, response: Response, query: Annotated[CreationQuery, Query()]
) -> Any:
    private(response)
    scope: Scope = (
        {"kind": "category", "id": query.category_id}
        if query.category_id
        else {"kind": "workspace"}
    )
    return channel_creation_check(db, actor, scope)
