"""D27: finite pure decisions over current bounded projections, never grant writes."""

from dataclasses import dataclass, replace
from typing import Any, TypedDict
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.database.organization_scope import bound_organization_column
from app.systems.access.policy.models import Group, GroupMember
from app.systems.access.policy.scope import effective_levels
from app.systems.access.users.membership import bound_organization
from app.systems.access.users.models import User
from app.systems.comms.access import (
    ConversationAccess,
    error,
    explain_conversation_access,
    fresh_membership,
    require_conversation_access,
)
from app.systems.comms.settings.models import CommsCapabilityGrant
from app.systems.comms.settings.resolution import (
    Scope,
    ScopeContext,
    locked_keys,
    normalize_scope,
    scope_clause,
    scope_context,
)

POSTER_CAPABILITIES = ("react", "reply", "createThread", "attachFiles", "linkRecords")
CONVERSATION_CAPABILITIES = (*POSTER_CAPABILITIES, "mentionChannel", "pin", "manageThreads",
                             "deleteOthersMessages", "moderate", "manageChannel")
CAPABILITIES = (*CONVERSATION_CAPABILITIES, "createChannel", "manageWorkspace")
GROUP_SCOPES = {
    "reply": ("workspace", "category", "channel"),
    "mentionChannel": ("workspace", "category", "channel"),
    "pin": ("workspace", "category", "channel"),
    "manageThreads": ("workspace", "category", "channel"),
    "deleteOthersMessages": ("workspace", "category", "channel"),
    "moderate": ("workspace", "category", "channel"),
    "manageChannel": ("category", "channel"),
    "createChannel": ("workspace", "category"),
}


class CapabilityDecision(TypedDict):
    allowed: bool
    source: dict[str, Any]


@dataclass(frozen=True)
class Grant:
    capability: str
    scope: Scope
    granted: bool
    group_id: UUID | None
    group_name: str | None


@dataclass(frozen=True)
class CapabilityInputs:
    role: str
    access: ConversationAccess
    chain: tuple[Scope, ...]
    grants: tuple[Grant, ...]
    locks: frozenset[str]
    creation_department: UUID | None
    # Owner decision 2026-10-22: a createChannel grant creates channels only in a department
    # where the actor holds a department role; False means the grant does not apply here.
    grant_department: bool = True


def _load_capability_inputs(
    db: Session, actor: User, context: ScopeContext, access: ConversationAccess,
    *, channel_grants: bool = False,
) -> CapabilityInputs:
    membership = fresh_membership(db, actor)
    if membership is None:
        raise error("person_not_found", "Person not found")
    groups = select(GroupMember.group_id).join(Group, Group.id == GroupMember.group_id).where(
        GroupMember.org_id == bound_organization_column(),
        Group.org_id == bound_organization_column(), GroupMember.user_id == actor.id,
        GroupMember.is_deleted.is_(False), Group.is_deleted.is_(False),
    )
    rows = db.execute(select(CommsCapabilityGrant, Group.name).outerjoin(
        Group, Group.id == CommsCapabilityGrant.group_id,
    ).where(
        or_(*(scope_clause(CommsCapabilityGrant, scope) for scope in context.chain)),
        or_(CommsCapabilityGrant.subject == "everyone", CommsCapabilityGrant.group_id.in_(groups)),
    ).execution_options(populate_existing=True)).all()
    grants = []
    for row, name in rows:
        scope = normalize_scope({"kind": row.scope, **(
            {"id": row.category_id or row.conversation_id} if row.scope != "workspace" else {}
        )})
        grants.append(Grant(row.capability, scope, row.granted, row.group_id, name))
    # Explain additive grants deterministically: ancestor first, then group ID.
    grants.sort(key=lambda item: (context.chain.index(item.scope), str(item.group_id)))
    department = context.department_id
    levels = effective_levels(db, actor, membership=membership)
    managed = levels.managed_department_ids()
    creation_department = department if department and (managed is None or department in managed) \
        else None
    # Department rows only: module rows are not a department role (owner decision 2026-10-22).
    grant_department = not channel_grants or (
        department is not None and levels.department_level(department) is not None
    )
    return CapabilityInputs(membership.role, access, context.chain, tuple(grants),
                            frozenset(locked_keys(db, "capability")), creation_department,
                            grant_department)


def _default(capability: str) -> str:
    if capability in POSTER_CAPABILITIES:
        return "poster"
    if capability == "createChannel":
        return "org_admin_or_department_manager"
    if capability == "manageWorkspace":
        return "org_admin"
    return "conversation_manager"


def _configured_decision(
    capability: str, inputs: CapabilityInputs, *, workspace_only: bool = False,
) -> CapabilityDecision:
    grants = [grant for grant in inputs.grants if grant.capability == capability
              and (not workspace_only or grant.scope["kind"] == "workspace")]
    poster = inputs.access.level in ("post", "manage")
    decision: CapabilityDecision = {
        "allowed": capability in POSTER_CAPABILITIES and poster,
        "source": {"kind": "default", "basis": _default(capability)},
    }
    if capability == "createChannel" and not workspace_only and inputs.creation_department:
        # D44 A7: a department manager creates that department's channels, in a category
        # bound to it or uncategorized; A8 binding is checked by the create path.
        category = next((scope for scope in inputs.chain if scope["kind"] == "category"), None)
        decision = {"allowed": True, "source": {
            "kind": "department_manager", "department_id": inputs.creation_department,
            "category_id": category["id"] if category else None,
        }}
    switches = [grant for grant in grants if grant.group_id is None]
    if switches:
        switch = switches[-1]
        decision = {"allowed": switch.granted and poster, "source": {
            "kind": "everyone", "scope": switch.scope, "enabled": switch.granted,
        }}
    added = next((grant for grant in grants if grant.group_id is not None and grant.granted), None)
    if added is not None and (capability != "createChannel" or inputs.grant_department):
        decision = {"allowed": True, "source": {
            "kind": "group_grant", "group_id": added.group_id,
            "group_name": added.group_name, "scope": added.scope,
        }}
    return decision


def capability_decision(capability: str, inputs: CapabilityInputs) -> CapabilityDecision:
    """Pure D27 resolution shared by checks and creation/management decisions."""
    if capability not in CAPABILITIES:
        raise ValueError("Unknown capability")
    if inputs.role == "guest":
        return {"allowed": False, "source": {"kind": "guest_cap"}}
    if inputs.access.level == "none":
        reason = "inactive_membership" if inputs.access.source.get("reason") == \
            "inactive_membership" else "no_read_access"
        return {"allowed": False, "source": {"kind": "access", "reason": reason}}
    if inputs.role == "admin":
        return {"allowed": True, "source": {"kind": "admin"}}
    if inputs.access.manager_source and capability in CONVERSATION_CAPABILITIES:
        return {"allowed": True, "source": {
            "kind": "manager", "reason": inputs.access.manager_source,
        }}
    if capability in inputs.locks:
        enabled = _configured_decision(capability, inputs, workspace_only=True)["allowed"]
        return {"allowed": enabled, "source": {"kind": "workspace_lock", "enabled": enabled}}
    return _configured_decision(capability, inputs)


def capability_check(db: Session, user: User, conversation_id: UUID) -> dict[str, Any]:
    context = scope_context(db, {"kind": "channel", "id": conversation_id})
    access = explain_conversation_access(db, user, conversation_id)
    inputs = _load_capability_inputs(db, user, context, access, channel_grants=True)
    conversation = context.conversation
    assert conversation is not None
    return {
        "org_id": bound_organization(db), "user_id": user.id,
        "conversation_id": conversation_id, "category_id": conversation.category_id,
        "membership_role": inputs.role, "conversation_level": access.level,
        "manager_source": access.manager_source, "access_source": access.source,
        "capabilities": {capability: capability_decision(capability, inputs)
                         for capability in CAPABILITIES},
    }


def inspect_capabilities(
    db: Session, actor: User, conversation_id: UUID, *, user_id: UUID | None = None,
) -> dict[str, Any]:
    require_conversation_access(db, actor, conversation_id, "read")
    own = capability_check(db, actor, conversation_id)
    if user_id is None or user_id == actor.id:
        return own
    if not own["capabilities"]["manageChannel"]["allowed"]:
        raise error("comms_manage_denied", "Channel management is required", 403)
    target = db.scalar(select(User).where(User.id == user_id).execution_options(
        populate_existing=True,
    ))
    if target is None or fresh_membership(db, target) is None:
        raise error("person_not_found", "Person not found")
    return capability_check(db, target, conversation_id)


def channel_creation_check(
    db: Session, actor: User, scope: Scope, department_id: UUID | None = None,
    *, channel: bool = True,
) -> dict[str, Any]:
    """``department_id`` is the requested channel's department when it has one (D44 A7).

    ``channel=False`` keeps a category creation on the unrestricted createChannel grant.
    """
    scope = normalize_scope(scope)
    if scope["kind"] == "channel":
        raise error("comms_scope_invalid", "Creation requires workspace or category scope", 422)
    context = scope_context(db, scope)
    if department_id is not None and context.department_id is None:
        context = replace(context, department_id=department_id)
    # Creation is a scope decision before a conversation exists, not borrowed channel access.
    inputs = _load_capability_inputs(db, actor, context, ConversationAccess(
        "read", None, {"kind": "organization"},
    ), channel_grants=channel)
    return {
        "org_id": bound_organization(db), "user_id": actor.id, "scope": scope,
        "membership_role": inputs.role, "decision": capability_decision("createChannel", inputs),
    }


def scope_management_decision(db: Session, actor: User, scope: Scope) -> CapabilityDecision:
    context = scope_context(db, scope)
    if context.conversation is not None:
        check = inspect_capabilities(db, actor, context.conversation.id)
        decision: CapabilityDecision = check["capabilities"]["manageChannel"]
        return decision
    inputs = _load_capability_inputs(db, actor, context, ConversationAccess(
        "read", None, {"kind": "organization"},
    ))
    if scope["kind"] == "workspace":
        return capability_decision("manageWorkspace", inputs)
    if inputs.creation_department and inputs.role != "guest":
        return {"allowed": True, "source": {"kind": "admin"} if inputs.role == "admin" else {
            "kind": "manager", "reason": "department_manager",
        }}
    return capability_decision("manageChannel", inputs)


def _configuration(payload: object, scope: Scope) -> dict[str, Any]:
    """Pure finite configuration admission; no user/role subjects or deny vocabulary."""
    invalid = error("comms_capabilities_invalid", "Invalid capability configuration", 422)
    if not isinstance(payload, dict) or set(payload) != {"scope", "group_grants", "everyone"}:
        raise invalid
    if normalize_scope(payload["scope"]) != scope:
        raise invalid
    everyone, proposed = payload["everyone"], payload["group_grants"]
    if not isinstance(everyone, dict) or any(
        key not in POSTER_CAPABILITIES or not isinstance(value, bool)
        for key, value in everyone.items()
    ) or not isinstance(proposed, list):
        raise invalid
    grants: list[dict[str, Any]] = []
    seen: set[tuple[UUID, str]] = set()
    for grant in proposed:
        if not isinstance(grant, dict) or set(grant) != {"group_id", "capability"}:
            raise invalid
        capability = grant["capability"]
        if not isinstance(capability, str) or scope["kind"] not in GROUP_SCOPES.get(capability, ()):
            raise invalid
        try:
            value = grant["group_id"]
            group_id = value if isinstance(value, UUID) else UUID(value)
        except (ValueError, TypeError, AttributeError) as exc:
            raise invalid from exc
        pair = (group_id, capability)
        if pair in seen:
            raise invalid
        seen.add(pair)
        grants.append({"group_id": group_id, "capability": capability})
    return {"scope": scope, "group_grants": grants, "everyone": dict(everyone)}


def validate_capability_configuration(
    db: Session, scope: Scope, payload: object,
) -> dict[str, Any]:
    context = scope_context(db, scope)
    scope = context.chain[-1]
    normalized = _configuration(payload, scope)
    ids = {grant["group_id"] for grant in normalized["group_grants"]}
    if ids and set(db.scalars(select(Group.id).where(
        Group.org_id == bound_organization_column(), Group.is_deleted.is_(False), Group.id.in_(ids),
    ))) != ids:
        raise error("comms_capabilities_invalid", "Group is unavailable", 422)
    if scope["kind"] != "workspace":
        locks = locked_keys(db, "capability")
        existing = db.scalars(select(CommsCapabilityGrant).where(scope_clause(
            CommsCapabilityGrant, scope,
        )).execution_options(populate_existing=True)).all()
        old = {(row.capability, row.group_id, row.granted) for row in existing
               if row.capability in locks}
        new = {(grant["capability"], grant["group_id"], True)
               for grant in normalized["group_grants"] if grant["capability"] in locks}
        new.update((key, None, enabled) for key, enabled in normalized["everyone"].items()
                   if key in locks)
        if old != new:
            raise error("comms_capabilities_locked", "Workspace capability is locked", 403)
    return normalized
