from typing import Any


def normalize_email(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    normalized = value.strip().lower()
    if "@" not in normalized or normalized.startswith("@") or normalized.endswith("@"):
        raise ValueError("Invalid email address")
    local, _, domain = normalized.rpartition("@")
    if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
        raise ValueError("Invalid email address")
    return normalized


def normalize_username(value: Any) -> Any:
    return value.strip().lower() if isinstance(value, str) else value
