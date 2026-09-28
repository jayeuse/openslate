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


class FieldDisplayResolver:
    """Resolve a bounded result set without a user lookup for each record."""

    def __init__(self, db: Session, module_id: UUID, fields: Iterable[Field]) -> None:
        self.fields = {str(field.id): field for field in fields}
        self.options: dict[str, dict[str, str]] = {}
        for field_id, field in self.fields.items():
            if FieldType(field.type) is FieldType.SELECT:
                options = field.config.get("options", [])
                self.options[field_id] = {
                    option["id"]: option["label"]
                    for option in options
                    if isinstance(option, dict)
                    and isinstance(option.get("id"), str)
                    and isinstance(option.get("label"), str)
                }
        self.users: dict[str, str] = {}
        if any(FieldType(field.type) is FieldType.USER for field in self.fields.values()):
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
        if FieldType(field.type) is FieldType.SELECT:
            return self.options.get(str(field.id), {}).get(str(value), UNAVAILABLE_OPTION)
        if FieldType(field.type) is FieldType.USER:
            return self.users.get(str(value), UNAVAILABLE_USER)
        return str(value)

    def display_values(self, data: dict[str, Any]) -> dict[str, str]:
        return {
            field_id: self.label(field, value)
            for field_id, value in data.items()
            if (field := self.fields.get(field_id)) is not None
            and FieldType(field.type) in {FieldType.SELECT, FieldType.USER}
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
