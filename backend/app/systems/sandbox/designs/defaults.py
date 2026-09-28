"""Empty document defaults for a new Sandbox workspace."""

from app.systems.sandbox.designs.schemas import DOCUMENT_SCHEMA_VERSION, SandboxDocument

EMPTY_SANDBOX_DOCUMENT: dict[str, object] = {
    "kind": "openslate-sandbox",
    "schemaVersion": DOCUMENT_SCHEMA_VERSION,
    "design": {
        "departments": [],
        "modules": [],
        "relationships": [],
        "layout": {},
    },
    "triggers": [],
    "scenarios": [],
}


def empty_document() -> SandboxDocument:
    """Return a new validated Sandbox document with no configured entities."""

    return SandboxDocument.model_validate(EMPTY_SANDBOX_DOCUMENT)
