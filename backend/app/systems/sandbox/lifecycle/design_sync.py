"""Keep bound lifecycle effects in the current draft within the same transaction."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.users.membership import bound_organization
from app.systems.sandbox.designs.models import SandboxDocument as DocumentRow
from app.systems.sandbox.designs.schemas import SandboxDocument
from app.systems.sandbox.designs.service import _parse_row_document, _store_document
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.lifecycle.exceptions import LifecycleUnavailable
from app.systems.sandbox.lifecycle.planning_scope import LifecyclePlan, LifecycleScope, row_state
from app.systems.sandbox.lifecycle.schemas import LifecycleOperation, LifecycleTargetType
from app.systems.sandbox.publications.binding_keys import normalize_legacy_field_bindings
from app.systems.sandbox.publications.models import SandboxBinding
from app.systems.sandbox.publications.planner import BindingKind, _binding_map
from app.systems.sandbox.publications.rules import _field_key


def document_row(db: Session, *, lock: bool = False) -> DocumentRow:
    statement = select(DocumentRow).where(
        DocumentRow.singleton_key.is_(True), DocumentRow.org_id == bound_organization(db)
    )
    if lock:
        statement = statement.with_for_update(nowait=True).execution_options(populate_existing=True)
    row = db.scalar(statement)
    if row is None:
        raise LifecycleUnavailable("Sandbox document is unavailable")
    return row


def binding_identity(binding: SandboxBinding) -> dict[str, object]:
    return {
        key: getattr(binding, key)
        for key in (
            "id",
            "kind",
            "sandbox_id",
            "department_id",
            "module_id",
            "field_id",
            "trigger_id",
            "is_deleted",
            "deleted_at",
            "updated_at",
        )
    }


def owned_binding(
    binding: SandboxBinding,
    department_ids: set[UUID],
    module_ids: set[UUID],
    field_ids: set[UUID],
) -> bool:
    return (
        binding.kind == "department"
        and binding.department_id in department_ids
        or binding.kind == "module"
        and binding.module_id in module_ids
        or binding.kind in {"field", "relationship"}
        and binding.field_id in field_ids
    )


def design_review_state(
    db: Session, scope: LifecycleScope, target: LifecycleTargetType
) -> tuple[object | None, tuple[UUID, ...]]:
    if target is LifecycleTargetType.RECORD:
        return None, ()
    departments = (
        {row.id for row in scope.departments} if target is LifecycleTargetType.DEPARTMENT else set()
    )
    modules = (
        {row.id for row in scope.modules}
        if target in {LifecycleTargetType.DEPARTMENT, LifecycleTargetType.MODULE}
        else set()
    )
    fields = {row.id for row in scope.fields}
    bindings = list(db.scalars(select(SandboxBinding).order_by(SandboxBinding.id)))
    owned = [
        binding for binding in bindings if owned_binding(binding, departments, modules, fields)
    ]
    row = document_row(db)
    return {
        "document_id": row.id,
        "document_revision": row.revision,
        "document_hash": row.content_hash,
        "bindings": [binding_identity(binding) for binding in owned],
    }, tuple(binding.id for binding in owned)


def synchronize_design(db: Session, plan: LifecyclePlan) -> None:
    if plan.target_type is LifecycleTargetType.RECORD:
        return
    row = document_row(db)
    document = _parse_row_document(row)
    bindings = _binding_map(list(db.scalars(select(SandboxBinding).order_by(SandboxBinding.id))))
    try:
        normalize_legacy_field_bindings(document, bindings, persist=False)
    except ValueError as error:
        raise LifecycleUnavailable("Sandbox bindings are unavailable") from error
    selected = {
        kind: {item.entity_id for item in plan.rows if item.entity_type == kind}
        for kind in ("departments", "modules", "fields")
    }
    before = document.model_dump(mode="json", by_alias=True)
    if plan.operation is LifecycleOperation.PURGE:
        _remove_owned_design(document, bindings, selected)
    else:
        closed = plan.operation is LifecycleOperation.CLOSE
        for department in document.design.departments:
            binding = bindings["department"].get(department.id)
            if binding is not None and binding.department_id in selected["departments"]:
                department.closed = closed
        for module in document.design.modules:
            binding = bindings["module"].get(module.id)
            if binding is not None and binding.module_id in selected["modules"]:
                module.closed = closed
            if plan.target_type is not LifecycleTargetType.FIELD:
                continue
            for field in module.fields:
                field_binding = bindings["field"].get(_field_key(module.id, field.id))
                if field_binding is not None and field_binding.field_id in selected["fields"]:
                    field.closed = closed
                    if closed:
                        _prune_mappings(document, module.id, {field.id})
    if document.model_dump(mode="json", by_alias=True) != before:
        _store_document(row, document, plan.actor_id)


def lifecycle_field_order(
    db: Session, scope: LifecycleScope, target: LifecycleTargetType, operation: LifecycleOperation
) -> tuple[dict[UUID, int], list[object]]:
    """Keep the owner's live schema ordered without applying unrelated draft reorders."""
    if target is not LifecycleTargetType.FIELD:
        return {}, []
    field = scope.fields[0]
    if operation is LifecycleOperation.PURGE:
        owner = scope.modules[0]
        fields = list(
            db.scalars(
                select(Field)
                .where(Field.module_id == field.module_id)
                .order_by(Field.position, Field.id)
            )
        )
        effective = [
            item
            for item in fields
            if not item.is_deleted
            or (
                owner.is_deleted
                and owner.lifecycle_close_operation_id is not None
                and item.lifecycle_close_operation_id == owner.lifecycle_close_operation_id
            )
        ]
        # A purge removes a gap; it must not conceal an already-invalid duplicate order.
        positions = [item.position for item in effective]
        compacted = (
            {
                item.id: index
                for index, item in enumerate(item for item in effective if item != field)
            }
            if len(set(positions)) == len(positions)
            else {}
        )
        return {
            item.id: compacted.get(item.id, item.position) for item in fields if item != field
        }, [
            row_state("modules", owner).model_dump(mode="json"),
            *(row_state("fields", item).model_dump(mode="json") for item in fields),
        ]
    if operation is not LifecycleOperation.REOPEN:
        return {}, []
    if not field.is_deleted or field.type == FieldType.RELATIONSHIP:
        return {}, []
    document = _parse_row_document(document_row(db))
    bindings = _binding_map(list(db.scalars(select(SandboxBinding).order_by(SandboxBinding.id))))
    try:
        normalize_legacy_field_bindings(document, bindings, persist=False)
    except ValueError as error:
        raise LifecycleUnavailable("Sandbox bindings are unavailable") from error
    matches_owner = any(
        (module_binding := bindings["module"].get(module.id)) is not None
        and module_binding.module_id == field.module_id
        and any(
            (binding := bindings["field"].get(_field_key(module.id, item.id))) is not None
            and binding.field_id == field.id
            for item in module.fields
        )
        for module in document.design.modules
    )
    if not matches_owner:
        return {}, []
    active = list(
        db.scalars(
            select(Field)
            .where(Field.module_id == field.module_id, Field.is_deleted.is_(False))
            .order_by(Field.position, Field.id)
        )
    )
    if [item.position for item in active] != list(range(len(active))):
        return {}, []
    insertion = min(field.position, len(active))
    ordered = [*active[:insertion], field, *active[insertion:]]
    return {item.id: index for index, item in enumerate(ordered)}, [
        row_state("fields", item).model_dump(mode="json") for item in ordered
    ]


def _prune_mappings(document: SandboxDocument, module_id: str, field_ids: set[str]) -> None:
    for relationship in document.design.relationships:
        relationship.field_mappings = [
            mapping
            for mapping in relationship.field_mappings
            if not (
                relationship.source_module_id == module_id
                and mapping.source_field_id in field_ids
                or relationship.target_module_id == module_id
                and mapping.target_field_id in field_ids
            )
        ]


def _remove_owned_design(
    document: SandboxDocument,
    bindings: dict[BindingKind, dict[str, SandboxBinding]],
    selected: dict[str, set[UUID]],
) -> None:
    department_ids = {
        item.id
        for item in document.design.departments
        if (binding := bindings["department"].get(item.id)) is not None
        and binding.department_id in selected["departments"]
    }
    module_ids = {
        item.id
        for item in document.design.modules
        if item.department_id in department_ids
        or (
            (binding := bindings["module"].get(item.id)) is not None
            and binding.module_id in selected["modules"]
        )
    }
    relationship_ids = {
        item.id
        for item in document.design.relationships
        if item.source_module_id in module_ids
        or item.target_module_id in module_ids
        or (
            (binding := bindings["relationship"].get(item.id)) is not None
            and binding.field_id in selected["fields"]
        )
    }
    document.design.departments = [
        item for item in document.design.departments if item.id not in department_ids
    ]
    document.design.modules = [
        item for item in document.design.modules if item.id not in module_ids
    ]
    document.design.relationships = [
        item for item in document.design.relationships if item.id not in relationship_ids
    ]
    for module in document.design.modules:
        removed = {
            field.id
            for field in module.fields
            if (binding := bindings["field"].get(_field_key(module.id, field.id))) is not None
            and binding.field_id in selected["fields"]
        }
        module.fields = [field for field in module.fields if field.id not in removed]
        if module.title_field_id in removed:
            module.title_field_id = None
        _prune_mappings(document, module.id, removed)
    for entity_id in department_ids | module_ids | relationship_ids:
        document.design.layout.pop(entity_id, None)
