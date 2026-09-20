"""Opaque invalidation values shared by PostgreSQL and SSE transports."""

import json
import re
from dataclasses import dataclass
from uuid import UUID

from app.systems.access.users.permissions import Capability

_ENTITY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
RESYNC_ENTITY = "resync"
_ADMINISTRATOR_ENTITIES = frozenset(
    {"audit_logs", "files", "roles", "security_events", "users"}
)
_ALL_AUTHENTICATED_ENTITIES = frozenset({"workspace_profiles"})
_ENTITY_ONLY_ENTITIES = frozenset({"files", "saved_views", "workspace_profiles"})
_ENTITY_CAPABILITIES = {
    "departments": Capability.DEPARTMENTS_READ,
    "fields": Capability.FIELDS_READ,
    "modules": Capability.MODULES_READ,
    "records": Capability.RECORDS_READ,
    "relationships": Capability.RELATIONSHIPS_READ,
    "saved_views": Capability.RECORDS_READ,
}


@dataclass(frozen=True, slots=True)
class InvalidationEvent:
    """An event intentionally limited to cache invalidation metadata."""

    entity: str
    entity_id: UUID | None = None
    capability: Capability | None = None
    administrators_only: bool = False
    all_authenticated: bool = False

    def __post_init__(self) -> None:
        if not _ENTITY_PATTERN.fullmatch(self.entity):
            raise ValueError("invalid invalidation payload")

    def to_payload(self) -> dict[str, str]:
        payload = {"entity": self.entity}
        if self.entity_id is not None:
            payload["entity_id"] = str(self.entity_id)
        if self.capability is not None:
            payload["capability"] = self.capability.value
        return payload

    def to_json(self) -> str:
        return json.dumps(self.to_payload(), separators=(",", ":"), sort_keys=True)


def event_for_entity(entity: str, entity_id: UUID | None = None) -> InvalidationEvent:
    """Classify an audited table without exposing rows or audit snapshots."""

    return InvalidationEvent(
        entity=entity,
        entity_id=None if entity in _ENTITY_ONLY_ENTITIES else entity_id,
        capability=_ENTITY_CAPABILITIES.get(entity),
        administrators_only=entity in _ADMINISTRATOR_ENTITIES,
        all_authenticated=entity in _ALL_AUTHENTICATED_ENTITIES,
    )


def resync_event() -> InvalidationEvent:
    return InvalidationEvent(RESYNC_ENTITY)


def parse_invalidation_payload(payload: object) -> InvalidationEvent:
    """Validate an untrusted PostgreSQL notification before local fanout."""

    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError as error:
            raise ValueError("invalid invalidation payload") from error
    if not isinstance(payload, dict) or set(payload) - {"entity", "entity_id", "capability"}:
        raise ValueError("invalid invalidation payload")
    entity = payload.get("entity")
    entity_id = payload.get("entity_id")
    capability = payload.get("capability")
    if not isinstance(entity, str) or not _ENTITY_PATTERN.fullmatch(entity):
        raise ValueError("invalid invalidation payload")
    try:
        parsed_id = UUID(entity_id) if isinstance(entity_id, str) else None
        parsed_capability = Capability(capability) if isinstance(capability, str) else None
    except ValueError as error:
        raise ValueError("invalid invalidation payload") from error
    if entity_id is not None and parsed_id is None:
        raise ValueError("invalid invalidation payload")
    if capability is not None and parsed_capability is None:
        raise ValueError("invalid invalidation payload")
    if entity in _ENTITY_ONLY_ENTITIES and parsed_id is not None:
        raise ValueError("invalid invalidation payload")
    expected_capability = _ENTITY_CAPABILITIES.get(entity)
    if parsed_capability != expected_capability:
        raise ValueError("invalid invalidation payload")
    return InvalidationEvent(
        entity=entity,
        entity_id=parsed_id,
        capability=parsed_capability,
        administrators_only=entity in _ADMINISTRATOR_ENTITIES,
        all_authenticated=entity in _ALL_AUTHENTICATED_ENTITIES,
    )
