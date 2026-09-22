"""Compatibility for field bindings created before canonical key encoding."""

from hashlib import sha256
from typing import Any

from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.rules import _field_key


def normalize_legacy_field_bindings(
    document: SandboxDocument,
    bindings: dict[Any, dict[str, SandboxBinding]],
    *,
    persist: bool,
) -> None:
    fields = bindings["field"]
    for module in document.design.modules:
        for field in module.fields:
            canonical = _field_key(module.id, field.id)
            legacy = _legacy_field_key(module.id, field.id)
            if canonical == legacy or legacy not in fields:
                continue
            if canonical in fields:
                raise ValueError("Legacy field binding conflicts with a canonical field binding")
            binding = fields.pop(legacy)
            fields[canonical] = binding
            if persist:
                binding.sandbox_id = canonical


def _legacy_field_key(module_id: str, field_id: str) -> str:
    raw = f"{module_id}:{field_id}"
    if ":" not in module_id and ":" not in field_id and len(raw) <= 1_000:
        return raw
    return f"field:{sha256(f'{module_id}\x00{field_id}'.encode()).hexdigest()}"
