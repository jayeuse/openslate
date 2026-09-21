from app.systems.sandbox.designs.models import SandboxDocument, SandboxVersion


def test_document_and_version_payloads_are_declared_audit_redacted() -> None:
    assert SandboxDocument.__audit_redacted_fields__ == frozenset({"document"})
    assert SandboxVersion.__audit_redacted_fields__ == frozenset({"snapshot", "note"})


def test_version_label_storage_matches_the_80_character_portable_contract() -> None:
    assert SandboxVersion.__table__.c.label.type.length == 80
