"""Opaque invalidation values shared by PostgreSQL and SSE transports."""

import json
import re
from dataclasses import dataclass
from uuid import UUID

_ENTITY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
RESYNC_ENTITY = "resync"
PRIVATE_NOTIFICATION_ENTITY = "in_app_notifications"
_PRIVATE_INVALIDATION_ENTITIES = frozenset(
    {
        "reports",
        "report_runs",
        "report_run_rows",
        "report_schedules",
        "board_groups",
        "board_event_reminders",
        "board_post_revisions",
        "board_post_revision_attachments",
        "board_post_revision_record_links",
        "board_attachments",
        "board_record_links",
        "dashboard_widgets",
    }
)
_ADMINISTRATOR_ENTITIES = frozenset(
    {
        "audit_logs",
        "files",
        "security_events",
        "users",
        "backup_policies",
        "backup_runs",
        "update_statuses",
    }
)
_ALL_AUTHENTICATED_ENTITIES = frozenset({"dashboards", "departments", "workspace_profiles"})
_ENTITY_ONLY_ENTITIES = frozenset(
    {
        "dashboards",
        "departments",
        "files",
        "group_access",
        "group_members",
        "groups",
        "saved_views",
        "workspace_profiles",
    }
)
# Events about data inside one module carry that module and reach only an
# administrator or a subscriber who can read the module.
MODULE_SCOPED_ENTITIES = frozenset(
    {"fields", "modules", "records", "relationship_edges", "saved_views"}
)
BOARD_SCOPED_ENTITIES = frozenset({"boards", "board_posts", "board_events", "board_widgets"})


@dataclass(frozen=True, slots=True)
class InvalidationEvent:
    """An event intentionally limited to cache invalidation metadata."""

    entity: str
    entity_id: UUID | None = None
    module_id: UUID | None = None
    administrators_only: bool = False
    all_authenticated: bool = False
    recipient_id: UUID | None = None
    board_id: UUID | None = None

    def __post_init__(self) -> None:
        if (
            not _ENTITY_PATTERN.fullmatch(self.entity)
            or self.entity in _PRIVATE_INVALIDATION_ENTITIES
        ):
            raise ValueError("invalid invalidation payload")
        if self.entity in BOARD_SCOPED_ENTITIES:
            if (
                not isinstance(self.board_id, UUID)
                or self.entity_id is not None
                or self.module_id is not None
                or self.recipient_id is not None
                or self.administrators_only
                or self.all_authenticated
            ):
                raise ValueError("invalid invalidation payload")
        elif self.board_id is not None:
            raise ValueError("invalid invalidation payload")
        if self.entity == "dashboards" and (
            self.entity_id is not None or self.module_id is not None
        ):
            raise ValueError("invalid invalidation payload")
        if self.entity == PRIVATE_NOTIFICATION_ENTITY:
            if (
                not isinstance(self.recipient_id, UUID)
                or self.entity_id is not None
                or self.module_id is not None
                or self.administrators_only
                or self.all_authenticated
            ):
                raise ValueError("invalid invalidation payload")
        elif self.recipient_id is not None:
            raise ValueError("invalid invalidation payload")
        if self.module_id is not None and self.entity not in MODULE_SCOPED_ENTITIES:
            raise ValueError("invalid invalidation payload")

    def to_payload(self) -> dict[str, str]:
        payload = {"entity": self.entity}
        if self.entity_id is not None:
            payload["entity_id"] = str(self.entity_id)
        if self.module_id is not None:
            payload["module_id"] = str(self.module_id)
        if self.board_id is not None:
            payload["board_id"] = str(self.board_id)
        return payload

    def to_json(self) -> str:
        return json.dumps(self.to_payload(), separators=(",", ":"), sort_keys=True)

    def to_transport_payload(self) -> dict[str, str]:
        """Include the private routing subject only inside PostgreSQL NOTIFY."""

        payload = self.to_payload()
        if self.recipient_id is not None:
            payload["recipient_id"] = str(self.recipient_id)
        return payload

    def to_transport_json(self) -> str:
        return json.dumps(self.to_transport_payload(), separators=(",", ":"), sort_keys=True)


def event_for_entity(
    entity: str,
    entity_id: UUID | None = None,
    *,
    recipient_id: UUID | None = None,
    module_id: UUID | None = None,
    board_id: UUID | None = None,
) -> InvalidationEvent | None:
    """Classify an audited table without exposing rows or audit snapshots.

    A module-scoped event without its module fails closed to administrators.
    """

    if entity == "dashboard_widgets":
        entity = "dashboards"
    if entity in BOARD_SCOPED_ENTITIES:
        return InvalidationEvent(entity=entity, board_id=board_id) if board_id is not None else None
    if entity in _PRIVATE_INVALIDATION_ENTITIES:
        return None
    if entity == PRIVATE_NOTIFICATION_ENTITY:
        if recipient_id is None:
            return None
        return InvalidationEvent(entity=entity, recipient_id=recipient_id)
    scoped = entity in MODULE_SCOPED_ENTITIES
    return InvalidationEvent(
        entity=entity,
        entity_id=None if entity in _ENTITY_ONLY_ENTITIES else entity_id,
        module_id=module_id if scoped else None,
        administrators_only=entity in _ADMINISTRATOR_ENTITIES or (scoped and module_id is None),
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
    if not isinstance(payload, dict) or set(payload) - {
        "entity",
        "entity_id",
        "module_id",
        "recipient_id",
        "board_id",
    }:
        raise ValueError("invalid invalidation payload")
    entity = payload.get("entity")
    entity_id = payload.get("entity_id")
    module_id = payload.get("module_id")
    recipient_id = payload.get("recipient_id")
    board_id = payload.get("board_id")
    if not isinstance(entity, str) or not _ENTITY_PATTERN.fullmatch(entity):
        raise ValueError("invalid invalidation payload")
    if entity in BOARD_SCOPED_ENTITIES and set(payload) != {"entity", "board_id"}:
        raise ValueError("invalid invalidation payload")
    if entity == "dashboards" and set(payload) != {"entity"}:
        raise ValueError("invalid invalidation payload")
    if "board_id" in payload and entity not in BOARD_SCOPED_ENTITIES:
        raise ValueError("invalid invalidation payload")
    try:
        parsed_id = UUID(entity_id) if isinstance(entity_id, str) else None
        parsed_module_id = UUID(module_id) if isinstance(module_id, str) else None
        parsed_recipient_id = UUID(recipient_id) if isinstance(recipient_id, str) else None
        parsed_board_id = UUID(board_id) if isinstance(board_id, str) else None
    except ValueError as error:
        raise ValueError("invalid invalidation payload") from error
    if entity_id is not None and parsed_id is None:
        raise ValueError("invalid invalidation payload")
    if module_id is not None and parsed_module_id is None:
        raise ValueError("invalid invalidation payload")
    if recipient_id is not None and parsed_recipient_id is None:
        raise ValueError("invalid invalidation payload")
    if board_id is not None and parsed_board_id is None:
        raise ValueError("invalid invalidation payload")
    if entity in _ENTITY_ONLY_ENTITIES and parsed_id is not None:
        raise ValueError("invalid invalidation payload")
    scoped = entity in MODULE_SCOPED_ENTITIES
    if parsed_module_id is not None and not scoped:
        raise ValueError("invalid invalidation payload")
    return InvalidationEvent(
        entity=entity,
        entity_id=parsed_id,
        module_id=parsed_module_id,
        administrators_only=entity in _ADMINISTRATOR_ENTITIES
        or (scoped and parsed_module_id is None),
        all_authenticated=entity in _ALL_AUTHENTICATED_ENTITIES,
        recipient_id=parsed_recipient_id,
        board_id=parsed_board_id,
    )
