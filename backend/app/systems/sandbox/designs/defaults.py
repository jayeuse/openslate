"""Empty document defaults for a new Sandbox workspace."""

from app.systems.sandbox.designs.schemas import SandboxDocument

EMPTY_SANDBOX_DOCUMENT: dict[str, object] = {
    "kind": "openslate-sandbox",
    "schemaVersion": 2,
    "design": {
        "departments": [],
        "modules": [],
        "relationships": [],
        "layout": {},
    },
    "automations": [],
    "scenarios": [],
}


def empty_document() -> SandboxDocument:
    """Return a new validated Sandbox document with no configured entities."""

    return SandboxDocument.model_validate(EMPTY_SANDBOX_DOCUMENT)
