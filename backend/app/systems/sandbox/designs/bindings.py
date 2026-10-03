"""Project live bindings into the current document's canonical entity identities."""

from sqlalchemy import String, any_, literal, select, union_all
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.systems.sandbox.departments.models import Department
from app.systems.sandbox.designs.schemas import SandboxBindingResponse, SandboxBindingsResponse
from app.systems.sandbox.designs.service import SandboxDesignError, read_document
from app.systems.sandbox.fields.models import Field
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.publications.binding_keys import _legacy_field_key
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.rules import _field_key
from app.systems.sandbox.record_triggers.models import RecordTrigger


def read_bindings(db: Session) -> SandboxBindingsResponse:
    """Read the current projection without changing or committing the document."""
    try:
        current = read_document(db)
        identities: dict[tuple[str, str], tuple[str, str | None]] = {
            ("department", item.id): (item.id, None) for item in current.document.design.departments
        }
        for module in current.document.design.modules:
            identities["module", module.id] = (module.id, None)
            for field in module.fields:
                identities["field", _field_key(module.id, field.id)] = (field.id, module.id)
                identities["field", _legacy_field_key(module.id, field.id)] = (field.id, module.id)
        for relationship in current.document.design.relationships:
            identities["relationship", relationship.id] = (relationship.id, None)
        for trigger in current.document.triggers:
            identities["trigger", trigger.id] = (trigger.id, None)

        # One array parameter per branch bounds the read to this document, including
        # after many historical publications, without one SQL parameter per field.
        current_ids = {
            kind: literal(
                [key for (item_kind, key) in identities if item_kind == kind], ARRAY(String)
            )
            for kind in ("department", "module", "field", "relationship", "trigger")
        }
        active = SandboxBinding.is_deleted.is_(False)
        statement = union_all(
            select(
                SandboxBinding.kind, SandboxBinding.sandbox_id, Department.id, Department.is_deleted
            )
            .join(Department, Department.id == SandboxBinding.department_id)
            .where(
                active,
                SandboxBinding.kind == "department",
                SandboxBinding.sandbox_id == any_(current_ids["department"]),
            ),
            select(SandboxBinding.kind, SandboxBinding.sandbox_id, Module.id, Module.is_deleted)
            .join(Module, Module.id == SandboxBinding.module_id)
            .where(
                active,
                SandboxBinding.kind == "module",
                SandboxBinding.sandbox_id == any_(current_ids["module"]),
            ),
            select(SandboxBinding.kind, SandboxBinding.sandbox_id, Field.id, Field.is_deleted)
            .join(Field, Field.id == SandboxBinding.field_id)
            .where(
                active,
                (
                    (SandboxBinding.kind == "field")
                    & (SandboxBinding.sandbox_id == any_(current_ids["field"]))
                )
                | (
                    (SandboxBinding.kind == "relationship")
                    & (SandboxBinding.sandbox_id == any_(current_ids["relationship"]))
                ),
            ),
            select(
                SandboxBinding.kind,
                SandboxBinding.sandbox_id,
                RecordTrigger.id,
                RecordTrigger.is_deleted,
            )
            .join(RecordTrigger, RecordTrigger.id == SandboxBinding.trigger_id)
            .where(
                active,
                SandboxBinding.kind == "trigger",
                SandboxBinding.sandbox_id == any_(current_ids["trigger"]),
            ),
        )
        items = []
        resolved: set[tuple[str, str, str | None]] = set()
        for kind, stored_id, live_id, is_deleted in db.execute(statement):
            identity = identities.get((kind, stored_id))
            if identity is not None:
                sandbox_id, parent_sandbox_id = identity
                key = (kind, sandbox_id, parent_sandbox_id)
                if key in resolved:
                    raise SandboxDesignError(
                        "bindings_unavailable", "Sandbox bindings are unavailable", 503
                    )
                resolved.add(key)
                items.append(
                    SandboxBindingResponse.model_validate(
                        {
                            "kind": kind,
                            "sandbox_id": sandbox_id,
                            "parent_sandbox_id": parent_sandbox_id,
                            "live_id": live_id,
                            "is_deleted": is_deleted,
                        }
                    )
                )
        items.sort(key=lambda item: (item.kind, item.parent_sandbox_id or "", item.sandbox_id))
        return SandboxBindingsResponse(document_revision=current.revision, items=items)
    except SQLAlchemyError as error:
        raise SandboxDesignError(
            "bindings_unavailable", "Sandbox bindings are unavailable", 503
        ) from error
