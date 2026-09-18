from typing import Any
from unicodedata import category


def normalize_email(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    normalized = value.strip().lower()
    if (
        normalized.count("@") != 1
        or normalized.startswith("@")
        or normalized.endswith("@")
        or any(character.isspace() or category(character) == "Cc" for character in normalized)
    ):
        raise ValueError("Invalid email address")
    local, _, domain = normalized.rpartition("@")
    if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
        raise ValueError("Invalid email address")
    return normalized


def normalize_username(value: Any) -> Any:
    return value.strip().lower() if isinstance(value, str) else value
