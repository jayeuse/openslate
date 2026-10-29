"""Current, access-aware labels for stored field IDs."""

from collections.abc import Iterable
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.systems.access.policy.scope import module_reader_ids
from app.systems.access.users.models import User
from app.systems.sandbox.fields.models import Field, FieldType
from app.systems.sandbox.modules.models import Module
from app.systems.sandbox.records.models import Record
from app.systems.sandbox.records.schemas import RecordResponse

UNAVAILABLE_OPTION = "Unavailable option"
UNAVAILABLE_USER = "Unavailable user"


def label_readers(db: Session, module_id: UUID, fields: Iterable[Field]) -> frozenset[UUID] | None:
    """The module's readers when one of its fields holds a person, else ``None``.

    A record write reads them once and passes them to validation, assignment
    notifications and :class:`FieldDisplayResolver`.
    """

    if any(FieldType(field.type) is FieldType.USER for field in fields):
        return module_reader_ids(db, module_id)
    return None


class FieldDisplayResolver:
    """Resolve a bounded result set without a user lookup for each record.

    It keeps each field's type, so it labels values after a commit expires the
    fields. ``readers`` are the module's readers when the caller already read them.
    """

    def __init__(
        self,
        db: Session,
        module_id: UUID,
        fields: Iterable[Field],
        *,
        readers: frozenset[UUID] | None = None,
    ) -> None:
        by_id = {str(field.id): field for field in fields}
        self.types = {field_id: FieldType(field.type) for field_id, field in by_id.items()}
        self.options: dict[str, dict[str, str]] = {}
        for field_id, field in by_id.items():
            if self.types[field_id] is FieldType.SELECT:
                options = field.config.get("options", [])
                self.options[field_id] = {
                    option["id"]: option["label"]
                    for option in options
                    if isinstance(option, dict)
                    and isinstance(option.get("id"), str)
                    and isinstance(option.get("label"), str)
                }
        self.users: dict[str, str] = {}
        if FieldType.USER in self.types.values():
            if readers is None:
                readers = module_reader_ids(db, module_id)
            if readers:
                self.users = {
                    str(user_id): display_name or username
                    for user_id, display_name, username in db.execute(
                        select(User.id, User.display_name, User.username).where(
                            User.id.in_(readers)
                        )
                    )
                }

    def label(self, field: Field, value: Any) -> str:
        return self._label(str(field.id), FieldType(field.type), value)

    def _label(self, field_id: str, field_type: FieldType, value: Any) -> str:
        if field_type is FieldType.SELECT:
            return self.options.get(field_id, {}).get(str(value), UNAVAILABLE_OPTION)
        if field_type is FieldType.USER:
            return self.users.get(str(value), UNAVAILABLE_USER)
        return str(value)

    def display_values(self, data: dict[str, Any]) -> dict[str, str]:
        return {
            field_id: self._label(field_id, field_type, value)
            for field_id, value in data.items()
            if (field_type := self.types.get(field_id)) in {FieldType.SELECT, FieldType.USER}
            and value is not None
        }


def displayed_record(record: Any, resolver: FieldDisplayResolver) -> RecordResponse:
    response = RecordResponse.model_validate(record, from_attributes=True)
    return response.model_copy(update={"display_values": resolver.display_values(record.data)})


def record_title(db: Session, record: Record, module: Module) -> str:
    fallback = f"Record {str(record.id)[:8]}"
    if module.title_field_id is None:
        return fallback
    field = db.get(Field, module.title_field_id)
    if (
        field is None
        or field.module_id != module.id
        or field.is_deleted
        or FieldType(field.type)
        not in {
            FieldType.TEXT,
            FieldType.LONG_TEXT,
            FieldType.EMAIL,
            FieldType.URL,
            FieldType.INTEGER,
            FieldType.NUMBER,
            FieldType.DECIMAL,
            FieldType.SELECT,
        }
    ):
        return fallback
    value = record.data.get(str(field.id))
    if value is None or not str(value).strip():
        return fallback
    title = FieldDisplayResolver(db, module.id, (field,)).label(field, value)
    return fallback if title == UNAVAILABLE_OPTION or not title.strip() else title
