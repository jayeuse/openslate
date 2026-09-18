"""Flat capability validation and evaluation for application roles."""

from enum import StrEnum
from typing import Any, cast

from app.systems.access.users.models import Role


class Capability(StrEnum):
    DEPARTMENTS_READ = "departments.read"
    DEPARTMENTS_WRITE = "departments.write"
    MODULES_READ = "modules.read"
    MODULES_WRITE = "modules.write"
    FIELDS_READ = "fields.read"
    FIELDS_WRITE = "fields.write"
    RECORDS_READ = "records.read"
    RECORDS_WRITE = "records.write"
    RELATIONSHIPS_READ = "relationships.read"
    RELATIONSHIPS_WRITE = "relationships.write"


_KNOWN_CAPABILITIES = frozenset(capability.value for capability in Capability)
ALL_CAPABILITIES = tuple(sorted(_KNOWN_CAPABILITIES))


def validate_permissions(value: object) -> dict[str, Any]:
    """Validate a newly supplied flat role permission document."""

    if not isinstance(value, dict):
        raise ValueError("Permissions must be a flat object")
    for capability, granted in value.items():
        if not isinstance(capability, str) or capability not in _KNOWN_CAPABILITIES:
            raise ValueError(f"Unknown capability: {capability}")
        if type(granted) is not bool:
            raise ValueError("Permission values must be booleans")
    return cast(dict[str, Any], value)


def is_valid_permissions(value: object) -> bool:
    """Return whether a persisted permission document is effective-capable."""

    try:
        validate_permissions(value)
    except (TypeError, ValueError):
        return False
    return True


def effective_permissions(role: Role) -> list[str]:
    """Return the sorted capabilities effective for a role."""

    if role.role == "admin":
        return list(ALL_CAPABILITIES)
    permissions = getattr(role, "permissions", None)
    if not is_valid_permissions(permissions):
        return []
    valid_permissions = cast(dict[str, Any], permissions)
    return [
        capability for capability in ALL_CAPABILITIES if valid_permissions.get(capability) is True
    ]


def has_capability(role: Role, capability: Capability | str) -> bool:
    """Return whether a role grants one capability."""

    required = Capability(capability)
    if role.role == "admin":
        return True
    return required.value in effective_permissions(role)
